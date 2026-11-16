# Design Document

写真・動画共有アルバム（MVP v0.2）の設計書。

## Overview

LINEログインした利用者が、個人またはグループのアルバムで写真・動画を保管・閲覧・共有・コメントできるWebアプリ。フロント・バックエンド・IaC をすべて TypeScript で統一し、全リソースを AWS CDK で管理する。デプロイ先は東京リージョン（`ap-northeast-1`）。

本設計は `requirements.md`（要件1〜9）を満たすことを目的とし、steering（`product.md` / `tech.md` / `structure.md` / `security.md` / `conventions.md`）の制約を前提とする。認可は常にサーバ側の正本データで判定し、フロント表示だけで権限を守らない。

### 設計上の重要判断（要件で保留していた論点の確定）
- **単独 ID から正本を引く方法**: ListObjects のスキャンを避けるため、**locator index** を導入する。`media-locator/{mediaId}.json`（`albumId`/`ownerType`/`ownerId`）、`comment-locator/{commentId}.json`、`album-locator/{albumId}.json`（`ownerType`/`ownerId`）。画面URLに所有主体を含めず、O(1) で正本パスへ到達して認可する。
- **メディア状態機械**: `uploading → validating → ready | error`。再処理は `error(preview_failed) → validating` のみ許可（`error(invalid_file)` は再処理不可）。削除は `ready | error → deleting → trashed`。放置された `uploading`/`validating` は暫定24時間で `expired` へ失効。状態は後戻りしない（単調に進む）。
- **権限モデル**: 操作×役割で判定（要件8の権限表）。グループ管理者は `groups.adminUserIds`（配列）で表現し、将来の追加・移譲をデータ変更で拡張可能にする。
- **セッション**: 無期限の署名付きCookie。`users/{userId}.json.sessionVersion` と Cookie 内の版数を照合し、ログアウトで版数を上げて全Cookieを無効化する。Max-Age を付けないCookieはブラウザ終了で消える（＝実質的な自動失効）ため、ブラウザ上限の `Max-Age=400日` を付け、`GET /api/me` のたびに延長する（レビュー 2026-10-27）。
- **秘密情報の取得**: CDKは環境変数にSSMの**パス名のみ**を渡し（`COOKIE_SECRET_PARAM`等）、Lambda実行時に `@aws-sdk/client-ssm` で値を取得してプロセス内キャッシュする（`handlers/secrets.ts`）。秘密をCloudFormation/環境変数に平文展開せず、SecureStringのデプロイ時展開制約も回避する。
- **署名付きURL**: 発行は無料、費用は転送量。用途別に期限を分け、同一メディアは有効期限内で同一URLを再利用（キャッシュ・転送量削減）。プレビュー1h / 写真原本5分 / 動画再生30分（暫定）。アップロード用は参照用と別管理で、単一PUT 15分 / マルチパートの各パート 1h（暫定、`UPLOAD_URL_TTL_SECONDS`）。
- **S3 クライアントのチェックサム**: SDK v3 は既定でアップロードに CRC32 を付与し、署名付きURLでは空データのCRC32（`x-amz-checksum-crc32=AAAAAA==`）がURLに固定される。ブラウザ直送と両立しないため、S3 クライアントは `requestChecksumCalculation` / `responseChecksumValidation` を `WHEN_REQUIRED` にする（`repo/s3Client.ts`）。
- **削除は非同期**: `DELETE` は `deleting` にして即時応答し、コピー〜元削除はキュー経由Lambdaで実行・自動再試行する（HTTP APIの30秒制限回避）。キューは ProcessingStack に置き、API Lambda へは URL と送信権限を渡す（Processing → AuthApi の一方向参照）。投入に失敗しても削除は受理済みとし、定期掃除（10分）が再投入する。
- **再処理**: `error(preview_failed)` は投稿者が `POST /api/media/{mediaId}/reprocess` で再処理できる。API は原本を同じキーへ上書きコピー（`MetadataDirective=REPLACE`）して ObjectCreated を再発火させ、サムネイルLambdaが `error(preview_failed) → validating → ready | error` を行う（新しいインフラを増やさないため）。FFmpeg の Layer を後から配備した場合の回復手段を兼ねる。
- **時刻順ID**: `mediaId`/`commentId` は ULID または UUIDv7 を用い、ListObjectsV2 の辞書順＝登録日時順になるようにする。
- **回線ガードと保留管理はフロント責務**。サーバは容量・形式・権限の検証を独立して必ず行う。保留中はサーバAPIを呼ばない（mediaId を作らない）。

---

## Architecture

### 全体構成

```
[ブラウザ(React/Vite SPA)]
      │  HTTPS(同一オリジン)
      ▼
[CloudFront] ──(default)──▶ [静的フロントS3(非公開, OAC)]
      │
      └──(/api/*)──▶ [API Gateway HTTP API] ──▶ [API Lambda(TS)]
                                                     │
                        ┌────────────────────────────┼───────────────────────────┐
                        ▼                            ▼                           ▼
              [メタデータS3(非公開)]        [メディアS3(非公開)]         [SSM Parameter Store]
                                                     │ (ObjectCreated イベント)
                                                     ▼
                                          [サムネイル生成Lambda(TS)]
                                           - 写真・動画: FFmpeg(Lambda Layer)
```

- ブラウザは CloudFront の単一オリジンにアクセスする。`/api/*` のみ API Gateway へ転送し、それ以外は静的フロントを返す。
- API はキャッシュ無効。`Set-Cookie` / `Cookie` を適切に転送する。
- アップロード/ダウンロードは署名付きURLでブラウザ⇄メディアS3を直結し、Lambda を原本の転送経路にしない。
- **SPAルーティング**: 拡張子のないパス（`/albums/...`、招待URL等）は CloudFront Functions で `/index.html` に書き換える。CloudFront のカスタムエラーレスポンスでの一括 index.html 差し替えは使わない（`/api/*` の 403/404 まで 200 に化けるため）。

### CDKスタック分割

責務ごとに分割し、参照は下位→上位の一方向。循環参照を避けるため以下の配置とする。

| スタック | 主なリソース |
|---|---|
| `StorageStack` | メタデータS3、メディアS3、各Lifecycle、AWS Budgets |
| `AuthApiStack` | API Gateway HTTP API、API Lambda、IAMロール、SSM参照 |
| `ProcessingStack` | サムネイル生成Lambda、FFmpeg Layer、削除ワーカーLambda、SQS、EventBridge ルール |
| `DeliveryStack` | CloudFront + OAC、`/api/*` ルーティング、静的フロントS3とそのOrigin、CloudFront Functions |

- スタック間の参照は `Storage → Processing → AuthApi → Delivery` の一方向（AuthApi は Processing の削除キューを受け取るだけで、逆方向の参照は持たない）。
- **循環参照の回避策**:
  - S3→Lambda のイベントは直結せず **EventBridge 経由**（CDKの既知の循環参照回避）。対象は `originals/` プレフィックスのみ（`previews/`・`trash/` では起動しない）。
  - 静的フロントS3は **DeliveryStack 側に置く**（CloudFront のバケットポリシーとの循環を避ける）。
  - CloudFront ドメインに依存する値（メディアS3のCORS許可オリジン、Origin検証、LINEコールバックURL）は、デプロイ時の設定「公開オリジン」から作る。初回は空でデプロイし、CloudFront のドメインが決まったら設定して再デプロイする（招待URLは画面側で `window.location.origin` から作る）。
- **デプロイ時の設定は Git で管理する**: 公開オリジンと FFmpeg Layer は `infra/cdk.json` の context（`photoAlbum:appOrigin` / `photoAlbum:ffmpegLayer`）に本番の値を置く。環境変数 `APP_ORIGIN` / `FFMPEG_LAYER_ARN` は一時的な上書き用。FFmpeg Layer の指定が無いと synth をエラーにする（Layer なしは `none` で明示）。Layer の ARN はアカウントIDをリポジトリに書かず、テンプレート上で `AWS::AccountId` から組み立てる。以前は環境変数で毎回渡しており、設定漏れのデプロイで Layer が外れる障害が起きた（2026-11-16、tasks.md タスク24）。
- 削除保護: メディア・メタデータバケットは `RemovalPolicy.RETAIN`（誤削除防止）。

---

## 技術スタック

| レイヤ | 採用 | 補足 |
|---|---|---|
| フロント | React + TypeScript + Vite | スマホ優先レスポンシブ |
| スタイル | CSS Modules + CSS 変数（デザイントークン） | 色・書体・角丸・影・余白は `frontend/src/styles/tokens.css` に集約（パレット → 役割の2段構成）。画面・部品は役割の変数だけを参照する。CSS フレームワーク・外部 Web フォントは使わない（依存と通信量を増やさない） |
| ルーティング | React Router | 追加課金なし |
| 状態管理 | React Context + hooks | 必要が明確になれば Zustand を検討 |
| ローカル保存 | IndexedDB | 保留中アップロードの記録（要件9） |
| バックエンド | Node.js LTS Lambda + TypeScript | `nodejs24.x`（`nodejs20.x` は 2026-04-30 に Lambda で非推奨）。ログ保存期間は30日（暫定） |
| IaC | AWS CDK (TypeScript) | 全リソースをコード管理 |
| 認証 | LINE Login v2.1 OIDC | 認可コードフロー + state/nonce/PKCE |
| 画像・動画処理 | FFmpeg / ffprobe (Lambda Layer) | 写真の縮小JPEG化（EXIF の向きを反映し、出力に EXIF を含めない）・動画の冒頭フレーム抽出・コーデック判定。Layer は `infra/cdk.json` の context `photoAlbum:ffmpegLayer`（例 `ffmpeg:1`）で指定、既定パス `/opt/bin/ffmpeg`・`/opt/bin/ffprobe`（当初の Sharp は不要になり依存も削除） |
| 秘密情報 | SSM Parameter Store SecureString | |

---

## Components and Interfaces

### バックエンド レイヤリング

HTTP処理・認証認可・ドメインロジック・ストレージIO を分離する。S3キーのパス構造を上位（HTTP/画面）に漏らさない。

```
handlers/        HTTP入出力。リクエスト検証・レスポンス整形・エラー変換のみ。
  auth/, albums/, media/, comments/, groups/
app/ (usecase)   ドメインロジック。認可判定・状態遷移・整合性制御。
  authz/         所有権・メンバーシップ判定（正本参照）
auth/            OIDC検証・セッションCookie署名/検証・CSRF
repo/ (storage)  S3 JSON / オブジェクトのIO。ETag条件付き書き込み。locator index 管理。
domain/          型定義・状態機械・バリデーション（純粋関数中心）
shared/          共有型（フロントと共有するJSON型・エラー型）
```

### フロント 主要コンポーネント

```
styles/
  tokens.css        デザイントークン（色・書体・角丸・影・余白・動き）。見た目の変更はまずここ
  base.css          要素の基本スタイル（本文・見出し・入力欄・フォーカス表示・動きを減らす設定）
pages/
  LoginPage         未ログイン時。招待トークンの引き継ぎ・ログイン失敗理由の表示（要件1-10, 1-13）
  HomePage          ログイン後トップ。保留中アップロード通知（要件9）
  AlbumListPage     所有主体別アルバム一覧（グループはメンバー数と「グループを開く」付き）・アルバム/グループ作成。
                    アルバム作成の保存先は 自分だけ／所属グループ／新しいグループ（要件3-13）
  AlbumDetailPage   所属の表示・メディアグリッド（プレビューのみ）・アップロード・編集・コメント。
                    グループのアルバムは戻り先がそのグループの画面
  GroupPage         グループの中身: このグループのアルバム一覧と作成・メンバー一覧・招待URL発行/失効（要件2-9）・
                    グループの設定（名前の変更・削除。管理者のみ, 要件2-14/2-15）
  InvitePage        招待の明示参加
components/
  ui/               見た目の部品（Button / Card / Alert / Badge / Avatar / Field / Modal / Page / ProgressBar / EmptyState / Loading）
  AppLayout         ヘッダー（ナビ）・フッター（表示名・ログアウト）
  AlbumOwner        アルバムの所属（自分だけ／グループ「名前」）とだれが見られるか。グループはグループの画面へのリンク（要件3-12）
  MediaViewer       原本表示/動画再生（権限確認後の署名付きURL）。モーダル（<dialog>）
  MediaGrid / AlbumGrid / UploadPanel / CommentPanel
features/
  upload/           ファイル選択・容量判定・回線ガード・マルチパート制御・保留記録
services/api/       型付きAPIクライアント（shared型を利用）
store/              Context（セッション）
brand.ts            アプリ名・ロゴの絵文字（表示用）
```

- 画面には色・角丸などの値を直接書かない（`style={{ ... }}` で色を指定しない）。部品は CSS Modules、値は tokens.css の「役割」の変数を参照する。
- モーダルはブラウザ標準の `<dialog>`（`showModal()`）を使い、背面の操作不可・フォーカスの閉じ込め・Esc で閉じる動作をブラウザに任せる。表示状態は呼び出し側の state を正とする。

---

## Data Models

S3 JSON を用いたデータモデル。

### キー設計

```
# メタデータバケット
users/{userId}.json
identities/line/{sha256OfLineSub}.json
user-groups/{userId}/{groupId}.json        # 検索用インデックス（正本ではない）
groups/{groupId}.json                       # メンバーが正本
invites/{sha256OfInviteToken}.json
group-invites/{groupId}/{inviteId}.json     # 検索用インデックス（正本は invites/。管理者の有効招待一覧・失効に使う）
albums/{ownerType}/{ownerId}/{albumId}.json
media/{albumId}/{mediaId}.json              # メディア正本
media-locator/{mediaId}.json                # mediaId→albumId等の逆引き
album-locator/{albumId}.json                # albumId→ownerType/ownerId の逆引き
comments/{targetType}/{targetId}/{rootCommentId}/{commentId}.json
comment-locator/{commentId}.json            # commentId→対象/rootの逆引き
```

### 主要エンティティ（抜粋）

```typescript
// shared/types.ts（フロント・バックエンド共有）

type OwnerType = "user" | "group";
type MediaKind = "photo" | "video";
type MediaStatus =
  | "uploading" | "validating" | "ready" | "error"
  | "deleting" | "trashed" | "expired";
type MediaErrorReason = "invalid_file" | "preview_failed";

interface User {
  userId: string;        // 内部ID（ULID/UUID）
  displayName: string;   // LINE表示名（毎回ログイン時に更新）
  sessionVersion: number; // ログアウトでインクリメントし全Cookie無効化
  createdAt: string;     // UTC ISO 8601
}

interface Group {
  groupId: string;
  name: string;          // 必須・暫定50文字以内。管理者が変更できる
  adminUserIds: string[];  // 管理者集合（初期は作成者のみ）。将来の追加・移譲に対応
  memberUserIds: string[]; // メンバーの正本
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null; // 削除時刻（墓標）。あれば存在しないものとして扱う。無い・null は未削除
  deletedBy?: string | null; // 削除した管理者
}

interface Invite {
  // キーは sha256(token)。token 平文は保存しない
  groupId: string;
  expiresAt: string;     // 暫定7日
  revokedAt: string | null; // 失効時刻（管理者による失効）
  usedBy?: string | null;   // 使用した利用者の内部ID。1回限り。未設定の旧データは未使用扱い
  usedAt?: string | null;   // 使用時刻
  createdBy: string;
  createdAt: string;
}

interface Album {
  albumId: string;
  ownerType: OwnerType;
  ownerId: string;
  title: string;
  description: string;
  coverMediaId: string | null;
  coverSource: "auto" | "manual"; // 自動設定が手動を上書きしないため
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null; // 削除時刻（墓標）。あれば存在しないものとして扱う。無い・null は未削除
  deletedBy?: string | null; // 削除した利用者（二重実行を本人にだけ冪等に成功させる）
}

interface Media {
  mediaId: string;         // ULID/UUIDv7（時刻順）
  albumId: string;
  kind: MediaKind;
  status: MediaStatus;
  errorReason: MediaErrorReason | null;
  originalExt: string;
  displayFileName: string; // 表示用のみ
  declaredByteSize: number; // 申告値（署名のContent-Lengthに使用）
  declaredMimeType: string; // 申告値
  byteSize: number | null; // 実検証後に確定
  mimeType: string | null; // 実検証後に確定
  videoCodec: string | null; // 動画のみ。再生可否判定に使用
  capturedAt: string | null; // EXIF撮影日時（並べ替え用）
  fileLastModified: string | null; // File.lastModified（並べ替え/同一ファイル照合用）
  uploadId: string | null; // マルチパートのuploadId
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // 削除時のみ（deleting に移る時点で確定）
  trash?: { deletedDate: string; fromKeys: string[]; toKeys: string[]; movedAt: string | null; };
}

type CommentStatus = "active" | "deleted";

interface Comment {
  commentId: string;       // ULID/UUIDv7（時刻順）
  targetType: "album" | "media";
  targetId: string;
  rootCommentId: string;   // root 自身は commentId と同一
  replyToCommentId: string | null; // 誰への返信か（階層は増やさない）
  body: string;            // 墓標は空文字
  status: CommentStatus;
  authorUserId: string;
  createdAt: string;
  deletedAt: string | null;
}

interface ApiError {
  code: string;            // 機械可読
  message: string;         // 利用者向け説明
}
```

### 整合性・競合制御
- `groups` / `albums` / `media` の更新は **ETag 条件付き書き込み**（`If-Match`）。システム起因の更新（表紙自動設定、メンバー追加等）はサーバ内で読み直して再試行し、利用者編集が実際に競合したときのみ 409 を返す。
- 新規作成（`users` / `identities` / `invites` / 各 locator）は `If-None-Match: *` で作成し、競合時は既存を読み直す（初回ログインの二重作成防止）。
- 複数キー更新は非トランザクション。**正本を先、インデックス（locator / user-groups）を後**に書き、インデックス欠落は参照時に正本不在として扱い、再実行（冪等）で修復する。招待受け入れで `user-groups/` 書き込みが失敗しても、再実行でインデックスを書き直す。

---

## 主要フロー

### 1. 認証（要件1）
1. `GET /api/auth/line/start`：state・nonce・PKCE(verifier) を生成しサーバ側（署名付き一時Cookie等）に保持、LINE認可URLへリダイレクト。
2. `GET /api/auth/line/callback`：state 照合 → 認可コードをサーバで交換 → IDトークンの署名/issuer/audience/nonce/exp を検証。
3. `identities/line/{sha256(sub)}.json` を参照。無ければ `users/{userId}.json` を新規作成し対応を記録（初回ログイン）。
4. 署名付きセッションCookie（Secure/HttpOnly/SameSite=Lax、`Max-Age=400日`。`GET /api/me` で延長し実質無期限）を発行。
5. 変更系API（`POST /api/auth/logout` を含む）は Origin 検証で保護する。セッションCookieは SameSite=Lax のため、クロスサイトの変更系リクエストには送られない（CSRFトークンは使わない）。
6. キャンセル・失敗時は `{戻り先}?login_error=1` へ戻し、画面で説明と再ログイン導線を表示する。

### 2. アップロード（要件4・9）

```
[フロント]
  ファイル選択
   → 容量判定: 一括=合計 / 個別=単体、閾値50MB
   → 閾値以上なら回線ガード:
        navigator.connection で Wi-Fi/有線 と"確実に"判定できる場合のみ自動開始
        それ以外(モバイル/判定不能/取得不可)はブロック
          → ホーム通知用に IndexedDB へ保留記録(要件9)
          → ユーザーが「承認」すれば続行
   → 大容量(50MB以上 or 動画)はマルチパート、小容量は単一PUT

[単一PUT]  POST /api/albums/{albumId}/media/uploads
             → 署名付きPUT URL + mediaId（status=uploading, media-locator 作成）
           ブラウザ→S3 直接PUT

[マルチパート] POST /api/albums/{albumId}/media/uploads/multipart
             → CreateMultipartUpload、uploadId + 各パートの署名付きURL群
           ブラウザ: パートを並列(暫定3〜4)アップロード、パート毎に指数バックオフ再試行
           期限切れ時: POST .../uploads/{uploadId}/parts でパートURLを再発行
           POST /api/media/{mediaId}/uploads/{uploadId}/complete（開始した本人のみ・冪等）
             → サーバが ListParts で各パートのサイズ・ETagを取得し、合計＝申告サイズを検証
               （超過は413、不足・不一致は422）→ ListParts の ETag で CompleteMultipartUpload
             → status が uploading のときだけ validating に進める（イベント処理が先行していても巻き戻さない）
           クライアント申告のパート ETag は使わない

[EventBridge(originals/のObjectCreated)→サムネイルLambda]
   対象プレフィックスは originals/ のみ（previews/・trash/ では起動しない）
   現在状態を確認し deleting/trashed/expired/error(invalid_file) なら skip（単調性）
   uploading（単一PUTの到着）・error(preview_failed)（再処理）は validating に進めてから処理する
   status=validating → 実サイズ・MIME/マジックバイト(先頭Range)・動画コーデック検証
     失敗: status=error, errorReason=invalid_file（閲覧不可）
       （HEIF/AVIF の ftyp は動画として扱わない。ffprobe で映像ストリームが無い動画も invalid_file）
     成功: FFmpeg でプレビュー生成（署名付きURL入力。写真=縮小JPEG・メタデータ除去、動画=1秒目から thumbnail フィルタで黒フレーム回避）
           → previews/ 書き込み後に状態再確認（削除・失効済みなら ready にせず書いたプレビューを削除）→ status=ready
           → ready になったら表紙を再計算（最初の写真の自動設定）
     プレビュー生成失敗・ツール未配備: status=error, errorReason=preview_failed（投稿者が再処理可）
   コーデック: ffprobe で取得して videoCodec に記録（未配備なら null）。H.264 以外は画面で「再生できない場合がある」と表示し、
     拒否はしない（要件4-5との関係は tasks.md 18 の論点を参照）
```

- 署名の制限: 単一PUTは `Content-Length`/`Content-Type` を署名に含める。マルチパートは complete 時にサーバが ListParts で合計サイズを検証。各パートURLは一時認証情報の失効に備え再発行APIを用意。
- CORS: メディアS3は許可オリジン=アプリのオリジン、メソッド=PUT、ExposeHeaders に `ETag` を含める（またはサーバ側 ListParts で ETag を取得しクライアント申告を信用しない）。
- Content-Type は署名に含め、原本取得時は検証済みMIMEで `ResponseContentType` を上書きする。
- 未完了マルチパートは Lifecycle `AbortIncompleteMultipartUpload`（暫定1日）で破棄。
- 大容量動画: 一時領域へ丸ごと落とさず、マジックバイトは先頭Range、FFmpegは署名付きURL入力で必要部分のみ読む。Lambdaの一時領域/メモリ/タイムアウトを明示設定。

### 3. 表紙の自動選定（要件3）
- アルバムに最初の写真が `ready` になった時点で、`coverSource=auto` の場合のみ `coverMediaId` を自動設定（手動設定 `coverSource=manual` は上書きしない）。動画のみのアルバムで動画が自動表紙になっていても、写真が `ready` になった時点で写真に切り替える。
- 手動変更は「同一アルバム・`ready`・写真」に限定して受け付ける。`coverMediaId: null` の指定は「手動指定の解除」で、`coverSource=auto` に戻して即時に再選定する。
- 表紙メディア削除時（`DELETE` 受理で `deleting` にした時点）: 残存写真を優先 → 無ければ動画サムネイル → 無ければ null（プレースホルダ）。手動表紙が削除された場合も同じ順で再選定し、`coverSource=auto` に戻す。
- 再計算はシステム更新のため ETag 競合を内部で再試行する。削除時の再計算に失敗しても削除の受理は取り消さない（次回のメディア ready 時に回復）。
- アルバム一覧 API は表紙のプレビューURL（表紙メディアが同一アルバムの `ready` のときのみ）とグループ名を同梱して返す。

### 4. 削除とごみ箱（要件7・非同期）

```
DELETE /api/media/{mediaId}
  認証・権限確認（locator→正本→操作権限：投稿者 or 管理者 / 個人は所有者）
  削除確認後 status=deleting、deletedDate と退避先キーをこの時点で確定・保存
  SQS に削除ジョブを投入 → 202 を返す（API内でコピーしない）

[削除ワーカーLambda（SQS）]
  for each (original, preview):
     元が存在しなければスキップ（前回の実行で移動済み・プレビュー未生成）
     CopyObject originals/..|previews/.. → trash/{deletedDate}/..（確定済みキー）
     HeadObject でコピー先をサイズ(必要ならチェックサム)検証（ETag一致は条件にしない）
     検証失敗なら例外 → 元は残したまま trashed にせず、SQS の再試行に委ねる
  全コピー検証OK後に 元を DeleteObject → status=trashed、movedAt 記録
  失敗/未完了は可視性タイムアウト後に再実行（冪等、続きから）

[定期掃除（EventBridge スケジュール）]
  deleting が10分以上 → 削除ジョブ再投入
  uploading/validating が24時間以上 → 未完了MPUを中断し、残った原本・プレビューは
    （検証済みかもしれない原本を直接消さないため）削除と同じ手順で trash/{失効日}/ へ退避 → status=expired
    退避先は trash 情報として記録。途中で失敗しても状態は変わらず、次回の掃除で続きから実行
  1件の失敗で掃除全体を止めない
```

- 不変条件: コピー検証前に原本を消さない。`trash/` は参照/DL APIから完全除外。Lifecycle Expiration は `trash/` のみ（暫定30日）。`error` は投稿者/管理者が削除可能。

### 5. コメント（要件6）
- 一覧: 対象プレフィックスを `Delimiter='/'` で列挙して root 単位でページングする（暫定20 root/ページ、`nextToken`）。応答は `{ threads, authors(userId→表示名), canModerate, nextToken }`。
- 投稿: `comments/{targetType}/{targetId}/{rootCommentId}/{commentId}.json` + `comment-locator/{commentId}.json`。対象が `deleting` 以降/不存在なら投稿拒否。
- 返信は常に同一 `rootCommentId` 直下（2階層固定、孫なし）。`replyToCommentId` に返信先を記録して誰への返信か示す。
- 親削除: `status=deleted`, body 空, `deletedAt` 付与（墓標）。表示可能な子がある限り保持。子が全滅した墓標は非表示。
- 子削除: `status=deleted` で非表示。root/他を変更しない。
- 対象メディアが `deleting` 以降なら一般画面に非表示。
- XSS: 保存は入力値のまま（長さ・制御文字・空文字のみ検証）。表示はフレームワーク標準エスケープで、`dangerouslySetInnerHTML` を使わない。対象はコメント本文・タイトル・説明・グループ名・表示名・ファイル名。

### 6. 認証・セッション（要件1）
- ログイン開始時に戻り先（同一オリジンの相対パスに限定）を一時保持し、ログイン後に復帰。
- セッション無期限。Cookie に版数を含め、`users.sessionVersion` と照合。ログアウトで版数を上げ全Cookie無効化。
- コールバックのエラー/キャンセルは利用者向け表示＋再試行導線に変換。
- 2回目以降のログインで LINE 表示名を更新。

### 7. 招待制の新規登録（設計確定・実装はタスク22）

目的: 知らない人が勝手に使えないようにする（要件1-13, 2-12, 2-13）。LINEチャネルを「公開」にしても制限が効くよう、アプリ側で制御する。

- 既存LINE identityがあれば招待なしでログイン可。新規identityは有効な招待（未使用・未失効・期限内）が必須。無い場合は user/identity を作らず `/?login_error=<reason>` へ302。
- reason: `invite_required` / `invite_invalid` / `invite_revoked` / `invite_expired` / `invite_used`（従来の `1` は汎用エラーとして維持）。
- 招待トークンは `/api/auth/line/start?invite=<token>` で受け、署名cookie `oauth_tx` の `OauthTx.inviteToken` に保持し callback で使う。フロント LoginGate は `/invite?token=` のとき start に `&invite=` を付与する。
- Invite は `usedBy?` / `usedAt?`（任意。旧データは未使用扱い）。使用済み化(claim)は `putJsonIfMatch`（ETag）で行い、同時使用は片方が 409 で負ける。
- 共通ロジックは `app/invites.ts`（evaluate / claim）。`app/auth.ts` と `app/groups.ts` が利用する（循環import回避）。
- callback の新規登録順: 招待検証 → userId生成 → claim(usedBy=userId) → identity `putJsonIfAbsent` → user `putJsonIfAbsent`。途中失敗で「claim済みだが users/{usedBy} が無い」孤児claimになった場合、`usedAt` から5分（`ORPHAN_CLAIM_GRACE_MS`）経過後のみ再claim可（同一人物の二重コールバック競合を避けるため）。
- `acceptInvite`: 期限/失効検証後に claim。`usedBy===自分` なら冪等OK、他人なら 410 `invite_used`。`listInvites` は使用済みを除外。
- テスト観点: 既存ユーザー招待なしOK / 新規招待なし拒否かつ未作成 / 有効招待で作成 / 同一招待の2人目は invite_used / revoked・expired・invalid / 孤児claim猶予 / acceptInvite の1回限り・冪等・一覧除外。
- 却下案: 許可リスト方式（運用負荷）、LINEテスター登録のみ（人追加ごとにLINE操作が必要）。

### 8. アルバムとグループの関係（タスク25）

利用者からの指摘（2026-11-16）: 「グループを作らずにアルバムを作って共有すると、個人にもグループにも紐づかないアルバムに見える。共有したアルバムは、グループに所属したうえでグループの中にあるほうが分かりやすい。アルバムのグループと通常のグループの区別をなくしてほしい」。

- **データには区別がない**: アルバムは作成時から必ず `ownerType=user`（自分だけ）か `ownerType=group`（グループ）のどちらかに属する。グループもすべて同じ `groups/{groupId}.json` で、アルバム用の特別なグループは存在しない。本番データ（2026-11-16 時点のアルバム2件・グループ2件）も全件この形で、所有主体・locator・メンバーの検索用インデックスに不整合はなかった（データ移行は不要）。
- **原因は画面**: アルバムの画面に所属が出ない、グループの画面にメンバーと招待しかなくアルバムが出ない、グループ名によっては（例「みんなの写真」のような名前）分類名に見えて人の集まりだと分からない、の3点で「どこにも属さないアルバム」「アルバム用のグループ」があるように見えていた。
- **方針: グループをアルバムの入れ物として見せる**
  - アルバムの画面に所属（`AlbumOwner`）を常に表示し、グループのアルバムは戻り先をそのグループの画面にする（要件3-12）。
  - グループの画面を「グループの中身」にする: このグループのアルバム一覧と作成・メンバー・招待（要件2-9）。
  - アルバム一覧のグループ見出しにメンバー数と「グループを開く」を出す（要件3-12）。
  - アルバム作成の保存先に「新しいグループを作って共有する」を加える。選ぶと通常のグループを作り（`POST /api/groups`）、続けてその中にアルバムを作る（`POST /api/albums`）。作成後はグループの画面へ移り、招待へ進める（要件3-13）。
    - 2回の API 呼び出しはトランザクションではない。グループだけ作れてアルバム作成に失敗した場合は、画面の保存先をそのグループに切り替える（再試行でグループを二重に作らない）。残ったグループは通常の空のグループとして使え、不要なら管理者が削除できる（9章）。
- **API の追加・変更**（いずれも既存の正本と認可をそのまま使う。保存するデータの形は変えない）
  - `GET /api/albums?groupId=`: そのグループのアルバムだけを返す。メンバーシップは正本で判定し、非メンバー・存在しないグループ・不正なID（空・128文字超・`/` を含む）は404（要件3-14, 2-10）。
  - `GET` / `PATCH /api/albums/{albumId}`: 応答を `AlbumDetail`（`Album` + `ownerName`）にする。グループ名は認可で読んだ `groups/` の正本から毎回付け、アルバムの JSON には保存しない（グループ名の二重管理を避ける）。
  - `GET /api/groups`: `GroupSummary` に `memberCount`（正本の `memberUserIds` の数）を加える。
- **採らなかった案**
  - 個人アルバムを後からグループへ移す機能: アルバムの正本キー（`albums/{ownerType}/{ownerId}/`）と locator の書き換えが要り、MVP では作成時に保存先を選べば足りるため見送り。要望があれば別タスクで検討する（tasks.md タスク25の論点）。
  - アルバムごとに隠れたメンバー集合（共有相手）を持たせる方式: 「グループと同じ扱いにして区別をなくす」という指摘と逆方向で、認可の正本が2種類になるため採らない。
  - 招待をグループの一般メンバーにも許す: 要件2-4（管理者のみ）の変更になるため、本タスクでは扱わない。

### 9. グループ名の変更と削除（タスク26）

- **権限**: どちらも管理者のみ（招待の管理と同じ `adminUserIds`。`domain/authz.ts` の `canManageGroup`）。非メンバーは404、管理者でないメンバーは403。
- **名前の変更** `PATCH /api/groups/{groupId}`（`{ name }`）: 作成時と同じ検証（前後の空白を除く・必須・暫定50文字以内）。グループ名はアルバムに複製していないので、アルバム一覧・アルバムの所属表示にもそのまま反映される。参加などのシステム更新と ETag が競合したら、読み直して（権限も確認し直して）再試行する。同じ名前なら書き込まない。
- **削除** `DELETE /api/groups/{groupId}`（204）:
  - 削除済みでないアルバムが1件でもあれば削除しない（409 `group_not_empty`）。グループごと消すとメンバー全員の写真・動画が見られなくなるため。グループを消すときは先にアルバムを消す方針（利用者確認済み 2026-11-16）。アルバムの削除は10章。削除済みのアルバム（墓標あり）は数えない。
  - 記録は消さずに `deletedAt` / `deletedBy` を付ける（墓標）。メタデータバケットはバージョニングしておらず、消すと戻せないため。復元の画面は作らない（必要なら運用者が `deletedAt` を外す）。
  - 削除済みは存在しないものとして扱う: `entities.getGroup` が null を返し、`isGroupMember` / `isGroupAdmin` も false を返す（二重の防御）。そのため一覧・詳細・アルバムの閲覧と作成・招待の管理がすべて止まる。
  - 招待: `claimInvite` は招待先のグループが削除済み・存在しないとき `invite_revoked` を返し、招待を使用済みにしない（新規登録も参加もできない）。参加済みの人が招待を再実行しても、`addMemberWithRetry` が削除済みのグループには加えない（410）。
  - 二重実行は冪等: 削除済みでも削除前の管理者には成功を返す。それ以外の人には404で存在を隠す。
  - user-groups の検索用インデックスは消さない（正本照合で除外される。API Lambda の権限も増やさない）。
  - 既知の競合: 削除とまったく同時に別のメンバーがアルバムを作ると、削除済みのグループにアルバムが残ることがある。そのアルバムは誰にも見えず、写真も追加できない。データは消えないので、グループを戻せば元どおりになる。
- **画面**: グループの画面の下に「グループの設定」（管理者のみ）。名前の入力欄と「名前を変える」、「グループを削除」。アルバムがあるときは削除ボタンを押せず、理由を表示する。削除はブラウザの確認ダイアログを経て行い、成功したらアルバム一覧へ移る。

### 10. アルバムの削除（タスク27）

利用者の依頼（2026-11-16）。グループは「先にアルバムを削除してから」でないと削除できない（9章）ため、アルバム削除を追加する。

- **権限**（`domain/authz.ts` の `canDeleteAlbum`）: 個人アルバムは所有者、グループのアルバムは**作成者またはグループ管理者**。メディア・コメントの削除権限（投稿者または管理者）と同じ考え方で、権限表（要件8）に追加した。閲覧できなければ404、閲覧できても権限がなければ403。アルバム編集（作成者のみ）より広いのは、作成者が不在でも管理者が片付けられるようにするため。
- **`DELETE /api/albums/{albumId}`（204）の流れ**（`app/deletion.ts` の `deleteAlbum`）:
  1. アルバムの JSON に `deletedAt` / `deletedBy` を付ける（ETag 条件付き。表紙の自動設定などと競合したら読み直して再試行）。**この時点で全員の一覧・詳細・メディアの表示とURL発行・アップロード・コメントから外れる**（`authorizeAlbumView` が locator 経由で読むアルバムが削除済みなら404）。記録は消さない（復元用。メタデータはバージョニングしていないため）。
  2. 中のメディアのうち `ready` / `error` を `deleting` にして退避先キーを確定し、削除ジョブを返す。handler が SQS に投入し、あとは**既存の削除ワーカーがメディア1件ごとに**コピー→サイズ検証→元を削除→`trashed` を行う。ごみ箱の不変条件（コピー検証前に元を消さない、`trash/` のみ Lifecycle 30日）はメディア単体の削除と同じ。
  3. `uploading` / `validating` は触らない（処理の途中を壊さない）。放置されれば24時間後の失効（要件7-11）で `trash/` に退避される。`deleting` は再投入のためジョブに含める。`trashed` / `expired` は何もしない。
  - 表紙の再選定はしない（アルバムごと消えるため）。
  - メディアの数が多くても API の30秒に収まるよう、同時8件・12秒の予算で `deleting` にし、超えた分は定期掃除に任せる。SQS 投入の失敗も握りつぶさず警告のみ（定期掃除が再投入する。メディア削除と同じ）。
- **取りこぼしの回収**（定期掃除 `lambda/sweep.ts` ＋ `reapMediaOfDeletedAlbum`）: 10分ごとに走査する各メディアについて、`ready` / `error` で、アルバムが削除済みなら削除を始めて削除ジョブを投入する。アルバム削除の途中失敗、削除と同時にサムネイル生成が終わって `ready` になったメディアなどを拾う。アルバムが削除済みかは掃除1回の間アルバム単位でキャッシュする（メディアごとに読み直さない）。**最長でも約10分で、削除済みアルバムの中身はすべて退避に向かう**。
- **二重実行**: 削除済みなら、削除した本人（`deletedBy`）にだけ成功を返し、残りのメディアの処理も続ける。ほかの人には404（存在を隠す）。印の時刻は変えない。
- **コメント**: アルバムとメディアのコメントは JSON を消さない。削除済みアルバムでは対象の認可が通らないため、一覧・投稿とも404で一般画面に出ない（要件6-7 と同じ扱い）。
- **グループとの関係**: `deleteGroup` の「アルバムがあるか」は削除済みのアルバムを数えない。アルバムを全部削除すればグループを削除できる。
- **API の応答**: アルバム詳細（`AlbumDetail`）に `canDelete`（表示制御用）を加えた。認可はサーバ側で行う。
- **画面**: アルバムの画面の下に「アルバムの削除」（`canDelete` のときだけ）。確認ダイアログ（件数ではなく、写真・動画・コメントが見られなくなり約30日後に完全に削除されること、元に戻す画面がないことを明記）→ 成功したら戻り先（グループのアルバムはグループの画面、個人は一覧）へ移る。
- **インフラ**: 変更なし。API Lambda・定期掃除 Lambda はもともと、メタデータの読み書きと削除キューへの送信ができる。
- **採らなかった案**: アルバム JSON と中身を同期で全部移す（メディアが多いと30秒に収まらない）。アルバム自体を `deleting` → `trashed` の状態機械にする（墓標1項目で足りる）。
- **既知の制約**: 削除と同時に別のメンバーがアップロード中のメディア（`uploading`）は、24時間後の失効まで `trash/` に移らないが、誰にも見えず URL も発行されない。

---

## Correctness Properties

実装・テストで常に保たれるべき不変条件。

- **ごみ箱の安全性**: コピー先をサイズ検証する前に、元オブジェクト（`originals/` / `previews/`）を削除しない。
- **削除の冪等性と非同期完了**: `deleting`/`trashed` への再削除は副作用なく成功。途中失敗は状態を残し、ワーカー/定期掃除が続きから完了する（利用者の手動再実行に依存しない）。
- **状態の単調性**: メディア状態は後戻りしない。S3イベント処理は `deleting`/`trashed`/`expired`/`error(invalid_file)` を skip し、プレビュー書き込みで `ready` へ巻き戻さない。
- **一覧の健全性**: 一般一覧は `ready` のみ（投稿者本人には処理中/失敗も可）。`deleting` 以降・`uploading`・`validating`・`error`・`trash/` は一般一覧・署名付きURL発行から除外。
- **署名付きURLの原則**: `ready` 以外に原本/再生URLを発行しない。同一メディアは有効期限内で同一URLを再利用。
- **表紙の健全性**: 表紙は同一アルバムの `ready` 写真のみ。自動設定は手動設定を上書きしない。
- **所属の健全性**: アルバムは必ず個人（`user`）かグループ（`group`）のどちらかに属し、画面は常にその所属を表示する。共有用の特別なグループは作らない。グループ名はアルバムに複製せず、正本（`groups/`）から引く。
- **アルバム削除の安全性**: 削除済み（`deletedAt`）のアルバムは存在しないものとして扱い（`getAlbumByLocator` が null）、中のメディアが `ready` のままでも閲覧・URL発行・アップロード・コメントはアルバム経由で止まる。メディアのごみ箱退避はメディア削除と同じ不変条件（コピー検証前に元を消さない・冪等）に従い、取りこぼしは定期掃除が回収する。
- **グループ削除の安全性**: 削除済みでないアルバムがあるグループは削除しない。削除済み（`deletedAt`）のグループにはメンバーも管理者もいないものとして扱い、閲覧・作成・招待（新規登録と参加）をすべて止める。記録は消さない。
- **コメント階層**: root + children の2階層のみ。返信は同一 root 直下。親の墓標は表示可能な子がある限り保持。
- **認可の正本性**: 認可はクライアント申告値でなく、取得した正本JSON＋操作×役割の権限表に基づく。閲覧権限なしは404。
- **非開示**: 非メンバーにグループの存在を推測させない（404に揃える）。
- **インデックス整合**: locator・user-groups は正本ではない。欠落は正本不在として扱い、再実行で修復可能。新規作成は `If-None-Match: *`。
- **セッション**: ログアウトで版数が上がり、以後その版より前のCookieは無効。
- **時刻とID**: 時刻は UTC ISO 8601。`mediaId`/`commentId` は時刻順ID（ULID/UUIDv7）。

## 認可モデル

すべての保護APIで次を実施（要件8）:
1. セッションCookie検証 → `userId` 確定。
2. 対象リソースの**正本**を取得（単独IDは locator 経由で正本パスへ）。
3. 所有権/メンバーシップ判定:
   - `ownerType=user`: `album.ownerId === userId`。
   - `ownerType=group`: `groups/{ownerId}.json.memberUserIds` に `userId` が含まれる。
4. クライアント申告の `ownerId`/`albumId`/`mediaId` は判定に用いず、取得した正本の値で判断。

---

## Error Handling

- API は `ApiError { code, message }` を機械可読で返す。HTTPステータスは意味づけ（401未認証 / 403操作権限なし / 404不存在または閲覧権限なし / 409競合 / 413容量超過 / 415形式不正 / 422検証失敗 / 202削除受理）。
- 閲覧権限のない参照は404に揃え、存在を推測させない。403は閲覧可だが操作不可の場合に限る。
- フロントは `code` で分岐し、`message` を利用者向けに表示。
- 署名付きURL発行時に権限喪失 → 発行拒否。既発行URLは各期限（プレビュー1h/写真5分/動画30分）まで有効になり得る点は仕様として許容。

---

## セキュリティ設計（要件8・security.md）

- 3バケットすべて Block Public Access 有効。静的フロントは CloudFront OAC のみ参照可。フロントはHTTPS、APIと認証Cookieは同一オリジン。
- OIDC: 署名/issuer/audience/nonce/exp を検証。state/PKCE 必須。
- セッションCookie: Secure/HttpOnly/SameSite=Lax、署名付き、無期限。`sessionVersion` 照合でログアウト時に無効化。変更系は Origin/CSRF 対策。
- 認可は操作×役割の権限表（requirements 要件8）で判定。管理者は `adminUserIds` 配列。
- 公開範囲は招待制。管理者のみ招待発行。ユーザー/グループ総容量上限とAPI Gatewayスロットリング。Budgetsは通知のみ（自動停止しない）。
- 秘密情報は SSM SecureString。フロント・Git に出さない。**CDKは環境変数にSSMパス名のみを渡し、Lambda実行時に `@aws-sdk/client-ssm` で値を取得・プロセス内キャッシュ**する（`handlers/secrets.ts`）。CloudFormationテンプレートやLambda環境変数に秘密の平文を残さない（SecureStringのデプロイ時展開制約も回避）。LambdaにはSSM GetParameters + KMS Decrypt(ssm経由限定)の最小権限を付与。
- IAM 最小権限: Lambda は対象バケット/プレフィックス限定。`s3:*`・`*` リソース不可。`trash/` への署名付きURL発行権限は与えない。アップロード署名に `Content-Length`/`Content-Type` を含める（presigner は既定で content-type を署名しないため `signableHeaders` で明示する）。
  - API Lambda: メタデータ RW、メディアは `originals/*`・`previews/*` の読み取りと `originals/*` への書き込みのみ、削除キューへの送信。
  - サムネイル: `originals/*` 読み取り、`previews/*` 書き込み・削除（生成中に削除されたメディアの片付け）。
  - 削除ワーカー・定期掃除: `originals/*`・`previews/*`・`trash/*` 読み取り、`trash/*` 書き込み、`originals/*`・`previews/*` 削除（`trash/` の削除は Lifecycle のみ）。定期掃除はさらに `originals/*` の `AbortMultipartUpload`。
- API Gateway は `$default` ステージにスロットリング（暫定: 20 req/秒、バースト40。`API_THROTTLE_RATE`/`API_THROTTLE_BURST`）。
- 入力検証: 形式は拡張子だけで判断せず、アップロード後に実サイズ・MIME/マジックバイト・動画コーデックを検証。プレビュー生成時にEXIF位置情報を除去。
- CDK に Budgets、ログ保存期間、パブリック公開防止ガードを組み込む。

---

## Testing Strategy

- **ユニット（優先）**: domain の状態機械（単調性・再処理・失効）・バリデーション・操作別認可判定・表紙再選定（手動非上書き）・コメント2階層/墓標ルールなど純粋関数。
- **結合**: ローカル実行可能な範囲で repo 層のS3 IO（ETag競合・locator整合・冪等削除・条件付き作成）。環境未整備で実行不可なら「未検証」と明記。
- **各タスク共通観点**: 正常系 / 未認証 / 非メンバー（404） / 操作権限なし（403） / 二重実行・障害時の冪等性。
- フロント: 容量判定（合計/単体）・回線ガード分岐（判定不能時の確認・24時間抑制）・マルチパート再試行/パートURL再発行・保留記録（メモ型）のユニットテスト。
- **実機確認が必要（自動テスト不可）**: iOS Safari/LINE内ブラウザのファイル選択時のMIME/コーデック、LINE内ブラウザでのログイン/大容量アップロード、一時認証情報で署名したURLの実効期限、500MBオブジェクトのCopyObject所要時間。これらは「未検証」として扱い実機で確認する。

---

## 未確定事項・設計時の留意

- `architecture.md` は別AI作成の原典として温存。実装の正は本 design.md と steering とする。差分があれば本書を優先（AGENTS.md もこの優先順位に合わせて更新済み）。
- locator index 方式は MVP の S3 JSON 構成に最適化したもの。将来 DynamoDB へ段階移行する場合、locator と正本の対応をそのままテーブル化できる構造にしておく。
- AWS SDK for JavaScript v3 の既定チェックサムが署名付きURL生成/ブラウザアップロードに影響しないか実装時に確認する。→ 確認済み（2026-10-27）。既定設定では署名付きPUT/パートURLに空データのCRC32が入るため、`WHEN_REQUIRED` に設定した。実S3での挙動は実機で確認する。
- LINE ログインのチャネルが「開発中」のままだと権限保持者しかログインできない。公開手順に含める。ただし招待制（タスク22）の実装・デプロイ完了までは公開しない。
- 動画の冒頭フレーム抽出は FFmpeg 失敗（破損・コーデック差・黒フレーム）を想定し、失敗時は `error(preview_failed)` で再処理可能にする。
