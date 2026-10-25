# Design Document

写真・動画共有アルバム（MVP v0.2）の設計書。

## Overview

LINEログインした利用者が、個人またはグループのアルバムで写真・動画を保管・閲覧・共有・コメントできるWebアプリ。フロント・バックエンド・IaC をすべて TypeScript で統一し、全リソースを AWS CDK で管理する。デプロイ先は東京リージョン（`ap-northeast-1`）。

本設計は `requirements.md`（要件1〜9）を満たすことを目的とし、steering（`product.md` / `tech.md` / `structure.md` / `security.md` / `conventions.md`）の制約を前提とする。認可は常にサーバ側の正本データで判定し、フロント表示だけで権限を守らない。

### 設計上の重要判断（要件で保留していた論点の確定）
- **単独 ID から正本を引く方法**: ListObjects のスキャンを避けるため、**locator index** を導入する。`media-locator/{mediaId}.json`（`albumId`/`ownerType`/`ownerId`）、`comment-locator/{commentId}.json`、`album-locator/{albumId}.json`（`ownerType`/`ownerId`）。画面URLに所有主体を含めず、O(1) で正本パスへ到達して認可する。
- **メディア状態機械**: `uploading → validating → ready | error`。再処理は `error(preview_failed) → validating` のみ許可（`error(invalid_file)` は再処理不可）。削除は `ready | error → deleting → trashed`。放置された `uploading`/`validating` は暫定24時間で `expired` へ失効。状態は後戻りしない（単調に進む）。
- **権限モデル**: 操作×役割で判定（要件8の権限表）。グループ管理者は `groups.adminUserIds`（配列）で表現し、将来の追加・移譲をデータ変更で拡張可能にする。
- **セッション**: 無期限の署名付きCookie。`users/{userId}.json.sessionVersion` と Cookie 内の版数を照合し、ログアウトで版数を上げて全Cookieを無効化する。
- **署名付きURL**: 発行は無料、費用は転送量。用途別に期限を分け、同一メディアは有効期限内で同一URLを再利用（キャッシュ・転送量削減）。プレビュー1h / 写真原本5分 / 動画再生30分（暫定）。
- **削除は非同期**: `DELETE` は `deleting` にして即時応答し、コピー〜元削除はキュー経由Lambdaで実行・自動再試行する（HTTP APIの30秒制限回避）。
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
                                           - 写真: Sharp
                                           - 動画: FFmpeg(Lambda Layer)
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

- **循環参照の回避策**:
  - S3→Lambda のイベントは直結せず **EventBridge 経由**（CDKの既知の循環参照回避）。対象は `originals/` プレフィックスのみ（`previews/`・`trash/` では起動しない）。
  - 静的フロントS3は **DeliveryStack 側に置く**（CloudFront のバケットポリシーとの循環を避ける）。
  - CloudFront ドメインに依存する値（メディアS3のCORS許可オリジン、Origin検証、LINEコールバックURL、招待URL生成）は、**SSMパラメータに書き出して実行時に読む**か、独自ドメインを先に固定する。
- 削除保護: メディア・メタデータバケットは `RemovalPolicy.RETAIN`（誤削除防止）。

---

## 技術スタック

| レイヤ | 採用 | 補足 |
|---|---|---|
| フロント | React + TypeScript + Vite | スマホ優先レスポンシブ |
| ルーティング | React Router | 追加課金なし |
| 状態管理 | React Context + hooks | 必要が明確になれば Zustand を検討 |
| ローカル保存 | IndexedDB | 保留中アップロードの記録（要件9） |
| バックエンド | Node.js LTS Lambda + TypeScript | |
| IaC | AWS CDK (TypeScript) | 全リソースをコード管理 |
| 認証 | LINE Login v2.1 OIDC | 認可コードフロー + state/nonce/PKCE |
| 画像処理 | Sharp | サムネイル生成Lambda |
| 動画処理 | FFmpeg (Lambda Layer) | 冒頭フレーム抽出 |
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
pages/
  HomePage          ログイン後トップ。保留中アップロード通知（要件9）
  AlbumListPage     所有主体別アルバム一覧
  AlbumDetailPage   メディアグリッド（プレビューのみ）
  MediaViewer       原本表示/動画再生（権限確認後の署名付きURL）
  GroupPage         グループ作成・招待URL発行
features/
  upload/           ファイル選択・容量判定・回線ガード・マルチパート制御・保留記録
  comments/         2階層コメント表示・投稿・削除
services/api/       型付きAPIクライアント（shared型を利用）
store/              Context（セッション・保留アップロード）
```

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
  name: string;          // 必須・暫定50文字以内
  adminUserIds: string[];  // 管理者集合（初期は作成者のみ）。将来の追加・移譲に対応
  memberUserIds: string[]; // メンバーの正本
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface Invite {
  // キーは sha256(token)。token 平文は保存しない
  groupId: string;
  expiresAt: string;     // 暫定7日
  revokedAt: string | null; // 失効時刻（管理者による失効）
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
4. 署名付きセッションCookie（Secure/HttpOnly/SameSite=Lax、期限付き）を発行。
5. 変更系APIは Origin 検証 + CSRFトークンで保護。

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
           POST /api/media/{mediaId}/uploads/{uploadId}/complete
             → サーバが ListParts で合計サイズ・ETagを取得して検証 → CompleteMultipartUpload → status=validating

[EventBridge(originals/のObjectCreated)→サムネイルLambda]
   対象プレフィックスは originals/ のみ（previews/・trash/ では起動しない）
   現在状態を確認し deleting/trashed/expired/error(invalid_file) なら skip（単調性）
   status=validating → 実サイズ・MIME/マジックバイト(先頭Range)・動画コーデック検証
     失敗: status=error, errorReason=invalid_file（閲覧不可）
     成功: Sharp(EXIF回転・メタ除去)/FFmpeg(署名付きURL入力・黒フレーム回避)でプレビュー生成
           → previews/ 書き込み前後で状態再確認（削除済みなら書いたものを片付け）→ status=ready
     プレビュー生成失敗: status=error, errorReason=preview_failed（再処理可）
```

- 署名の制限: 単一PUTは `Content-Length`/`Content-Type` を署名に含める。マルチパートは complete 時にサーバが ListParts で合計サイズを検証。各パートURLは一時認証情報の失効に備え再発行APIを用意。
- CORS: メディアS3は許可オリジン=アプリのオリジン、メソッド=PUT、ExposeHeaders に `ETag` を含める（またはサーバ側 ListParts で ETag を取得しクライアント申告を信用しない）。
- Content-Type は署名に含め、原本取得時は検証済みMIMEで `ResponseContentType` を上書きする。
- 未完了マルチパートは Lifecycle `AbortIncompleteMultipartUpload`（暫定1日）で破棄。
- 大容量動画: 一時領域へ丸ごと落とさず、マジックバイトは先頭Range、FFmpegは署名付きURL入力で必要部分のみ読む。Lambdaの一時領域/メモリ/タイムアウトを明示設定。

### 3. 表紙の自動選定（要件3）
- アルバムに最初の写真が `ready` になった時点で、`coverSource=auto` の場合のみ `coverMediaId` を自動設定（手動設定 `coverSource=manual` は上書きしない）。
- 手動変更は「同一アルバム・`ready`・写真」に限定して受け付ける。
- 表紙メディア削除時: 残存写真を優先 → 無ければ動画サムネイル → 無ければ null（プレースホルダ）。

### 4. 削除とごみ箱（要件7・非同期）

```
DELETE /api/media/{mediaId}
  認証・権限確認（locator→正本→操作権限：投稿者 or 管理者 / 個人は所有者）
  削除確認後 status=deleting、deletedDate と退避先キーをこの時点で確定・保存
  SQS に削除ジョブを投入 → 202 を返す（API内でコピーしない）

[削除ワーカーLambda（SQS）]
  for each (original, preview):
     CopyObject originals/..|previews/.. → trash/{deletedDate}/..（確定済みキー）
     HeadObject でコピー先をサイズ(必要ならチェックサム)検証（ETag一致は条件にしない）
  全コピー検証OK後に 元を DeleteObject → status=trashed、movedAt 記録
  失敗/未完了は可視性タイムアウト後に再実行（冪等、続きから）

[定期掃除（EventBridge スケジュール）]
  deleting が10分以上 → 削除ジョブ再投入
  uploading/validating が24時間以上 → status=expired、残オブジェクトと未完了MPUを片付け
```

- 不変条件: コピー検証前に原本を消さない。`trash/` は参照/DL APIから完全除外。Lifecycle Expiration は `trash/` のみ（暫定30日）。`error` は投稿者/管理者が削除可能。

### 5. コメント（要件6）
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

---

## Correctness Properties

実装・テストで常に保たれるべき不変条件。

- **ごみ箱の安全性**: コピー先をサイズ検証する前に、元オブジェクト（`originals/` / `previews/`）を削除しない。
- **削除の冪等性と非同期完了**: `deleting`/`trashed` への再削除は副作用なく成功。途中失敗は状態を残し、ワーカー/定期掃除が続きから完了する（利用者の手動再実行に依存しない）。
- **状態の単調性**: メディア状態は後戻りしない。S3イベント処理は `deleting`/`trashed`/`expired`/`error(invalid_file)` を skip し、プレビュー書き込みで `ready` へ巻き戻さない。
- **一覧の健全性**: 一般一覧は `ready` のみ（投稿者本人には処理中/失敗も可）。`deleting` 以降・`uploading`・`validating`・`error`・`trash/` は一般一覧・署名付きURL発行から除外。
- **署名付きURLの原則**: `ready` 以外に原本/再生URLを発行しない。同一メディアは有効期限内で同一URLを再利用。
- **表紙の健全性**: 表紙は同一アルバムの `ready` 写真のみ。自動設定は手動設定を上書きしない。
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
- 秘密情報は SSM SecureString。フロント・Git に出さない。
- IAM 最小権限: Lambda は対象バケット/プレフィックス限定。`s3:*`・`*` リソース不可。`trash/` への署名付きURL発行権限は与えない。アップロード署名に `Content-Length`/`Content-Type` を含める。
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
- AWS SDK for JavaScript v3 の既定チェックサムが署名付きURL生成/ブラウザアップロードに影響しないか実装時に確認する。
- LINE ログインのチャネルが「開発中」のままだと権限保持者しかログインできない。公開手順に含める。
- 動画の冒頭フレーム抽出は FFmpeg 失敗（破損・コーデック差・黒フレーム）を想定し、失敗時は `error(preview_failed)` で再処理可能にする。
