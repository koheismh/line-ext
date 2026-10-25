# 写真・動画共有アルバム（MVP）

LINEログインした利用者が、本人または所属グループ内だけで写真・動画をアルバムとして保管・閲覧・共有・コメントできるWebアプリ。

仕様は `.kiro/specs/photo-album/`（requirements / design / tasks）と `.kiro/steering/` を正とする。

## 構成（npm workspaces モノレポ）

```
shared/    フロント・バックエンド共有の型・定数・ULID
backend/   ドメイン(domain) → ストレージ(repo) → ユースケース(app) → HTTP(handlers) → 認証(auth)
frontend/  React + Vite。pages / components / features/upload / services / store
infra/     AWS CDK。StorageStack / ProcessingStack / AuthApiStack / DeliveryStack
```

## 開発コマンド（ルートで実行）

```
npm install        # 依存インストール
npm run typecheck  # 全ワークスペースの型チェック
npm test           # 全ユニット/結合テスト
npm run lint       # ESLint
```

- フロント開発: `npm --workspace @photo-album/frontend run dev`（`/api` はバックエンドへプロキシ）
- フロントビルド: `npm --workspace @photo-album/frontend run build`
- CDK合成: `npm --workspace @photo-album/infra run synth`

## 受け入れテスト例とのトレーサビリティ

requirements の受け入れテスト例 → 担保する主な実装/テスト。

| # | 受け入れ例 | 実装/テスト |
|---|---|---|
| 1 | 個人アルバムは本人のみ、他人は非表示(404) | `app/authorize.ts` `app/albums.ts` / authorize.test, albums.test |
| 2 | 招待参加でグループ閲覧共有、非メンバー不可 | `app/groups.ts` / groups.test |
| 3 | 写真/MP4/MOVアップロード→プレビュー→表示 | `app/uploads.ts` `app/processing.ts` `app/mediaQuery.ts` |
| 4 | 手動表紙を自動設定が上書きしない/別アルバム不可 | `domain/cover.ts` `app/albums.ts` / cover.test, albums.test |
| 5 | 親削除後も子が残り、返信が2階層を超えない | `domain/comment.ts` `app/comments.ts` / comment.test, comments.test |
| 6 | 削除でtrashへ、通常キー消失、重複削除も不整合なし | `app/deletion.ts` / deletion.test |
| 7 | error/放置メディアを投稿者が片付けられる | `app/deletion.ts`（canStartDelete/expireStaleMedia） |
| 8 | 未ログイン/非メンバーは署名URL取得不可 | `app/mediaQuery.ts` `handlers/authMiddleware.ts` |
| 9 | 500MB動画を不安定回線で再試行完了 | `features/upload/multipartUploader.ts` / multipartUploader.test |
| 10 | 判定不能ブラウザはWi-Fiでも確認、承認後24h抑制 | `features/upload/networkGuard.ts` / networkGuard.test |
| 11 | 一括=合計/単体=単体で50MB判定 | `domain/validation.ts` `features/upload/size.ts` |
| 12 | 保留がホームに表示、選び直しで再開 | `features/upload/pendingStore.ts` `pages/HomePage.tsx` |
| 13 | ログアウト後は旧Cookieを拒否 | `auth/session.ts` `handlers/authMiddleware.ts` / session.test |
| 14 | 招待URL→ログイン→招待画面に戻り明示参加 | `auth/redirect.ts` `pages/InvitePage.tsx` / redirect.test |
| 15 | 長尺動画でURL期限切れ時に再取得 | `components/MediaViewer.tsx` `app/mediaQuery.ts` |

## デプロイ（実施には明示的な承認と手作業が必要）

> 本リポジトリはローカル検証まで完了。実AWSデプロイは未実施。

1. AWS 認証: `aws configure sso` → `aws sso login`（東京リージョン `ap-northeast-1`）
2. LINE Developers: チャネル作成、コールバックURL `https://<CloudFrontドメイン>/api/auth/line/callback` を登録
3. SSM Parameter Store に投入（SecureString）:
   - `/<env>/photo-album/cookie-secret`
   - `/<env>/photo-album/line-channel-id`
   - `/<env>/photo-album/line-channel-secret`
4. Lambda 実コードのバンドル（handlers/処理ロジックを esbuild 等でバンドルし、CDKのプレースホルダと差し替え）
5. `cdk deploy --all` → 出力の CloudFront ドメインを LINE コールバック・`ALLOWED_ORIGIN` へ反映

## 写真プレビュー（sharp）の有効化

サムネイル生成Lambdaは `sharp` を使うが、ネイティブ依存（linux-x64）のため**バンドルから external 扱いで切り離している**。
開発機に WSL2/Docker が無くてもデプロイできるようにするため。sharp 未供給の間、写真プレビューは
`error(preview_failed)` になる（他機能は動作する）。

有効化するには、linux-x64・Node20対応の **sharp Lambda Layer** を用意し、環境変数でARNを渡して deploy する:

```
$env:SHARP_LAYER_ARN = "arn:aws:lambda:ap-northeast-1:<acct>:layer:sharp:<ver>"
cdk deploy PhotoAlbum-Processing-dev
```

動画プレビュー（FFmpeg）も同様に Layer 前提。未配備時は動画プレビューを生成しない。

## 未検証（実機確認が必要）

- iOS Safari / LINE内ブラウザでのファイル選択時の MIME・コーデック
- 一時認証情報で署名したURLの実効期限、500MBオブジェクトの CopyObject 所要時間
- sharp/FFmpeg による実プレビュー生成（Layer配備後に有効化）
- 実ブラウザでの IndexedDB 保留・マルチパート並列アップロード・動画再生
```
