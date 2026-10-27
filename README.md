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
| 7 | error/放置メディアを投稿者が片付けられる | `app/deletion.ts`（canStartDelete/expireStaleMedia）/ deletion.test |
| 8 | 未ログイン/非メンバーは署名URL取得不可 | `app/mediaQuery.ts` `handlers/authMiddleware.ts` / mediaQuery.test, router.test |
| 9 | 500MB動画を不安定回線で再試行完了 | `features/upload/multipartUploader.ts` / multipartUploader.test |
| 10 | 判定不能ブラウザはWi-Fiでも確認、承認後24h抑制 | `features/upload/networkGuard.ts` / networkGuard.test |
| 11 | 一括=合計/単体=単体で50MB判定 | `domain/validation.ts` `features/upload/size.ts` |
| 12 | 保留がホームに表示、選び直しで再開 | `features/upload/pendingStore.ts` `pages/HomePage.tsx` |
| 13 | ログアウト後は旧Cookieを拒否 | `auth/session.ts` `handlers/authMiddleware.ts` / session.test, router.test |
| 14 | 招待URL→ログイン→招待画面に戻り明示参加 | `auth/redirect.ts` `pages/InvitePage.tsx` / redirect.test |
| 15 | 長尺動画でURL期限切れ時に再取得（再生位置から継続） | `components/MediaViewer.tsx` `app/mediaQuery.ts` |

## デプロイ（実施には明示的な承認と手作業が必要）

> 本リポジトリはローカル検証まで完了。実AWSデプロイは未実施。

1. AWS 認証: `aws configure sso` → `aws sso login`（東京リージョン `ap-northeast-1`）
2. LINE Developers: チャネル作成、コールバックURL `https://<CloudFrontドメイン>/api/auth/line/callback` を登録
3. SSM Parameter Store に投入（SecureString）:
   - `/<env>/photo-album/cookie-secret`
   - `/<env>/photo-album/line-channel-id`
   - `/<env>/photo-album/line-channel-secret`
4. `cdk deploy --all`（Lambda は NodejsFunction が esbuild で自動バンドル）→ 出力の CloudFront ドメインを `APP_ORIGIN` に指定して再デプロイ（LINE コールバック・CORS・`ALLOWED_ORIGIN` に反映）

デプロイ時の環境変数（任意）:

| 変数 | 用途 | 既定 |
|---|---|---|
| `APP_ORIGIN` | 公開オリジン（CloudFront ドメイン） | なし |
| `SHARP_LAYER_ARN` / `FFMPEG_LAYER_ARN` | 写真・動画プレビュー用 Layer | なし（プレビューは失敗扱い） |
| `API_THROTTLE_RATE` / `API_THROTTLE_BURST` | API Gateway のスロットリング | 20 / 40 |
| `MONTHLY_BUDGET_USD` / `BUDGET_NOTIFY_EMAIL` | 予算アラート | 20 / なし |

既にデプロイ済みの環境へ反映する場合の注意: Lambda のランタイムが `nodejs24.x` に変わり、ログ出力先が保存期間30日の新しいロググループになる（旧 `/aws/lambda/...` は残る）。スタック依存は `Storage → Processing → AuthApi → Delivery`。

## プレビュー（sharp / FFmpeg）の有効化

サムネイル生成Lambdaは写真に `sharp`、動画に FFmpeg / ffprobe を使う。どちらもネイティブバイナリ（linux-x64）のため
**バンドルに含めず Lambda Layer で供給する**（開発機に WSL2/Docker が無くてもデプロイできるようにするため）。
未供給の間、該当メディアは `error(preview_failed)` になり一般の一覧には出ない（投稿者には「再処理」ボタンが出る）。

- sharp: linux-x64 の sharp を含む Layer（sharp 0.33 は Node-API のため Node 24 でも動作）
- FFmpeg: `/opt/bin/ffmpeg` と `/opt/bin/ffprobe` を含む Layer（パスが異なる場合は Lambda の環境変数 `FFMPEG_PATH` / `FFPROBE_PATH`）。HTTPS 入力に対応したビルドが必要

```
$env:SHARP_LAYER_ARN = "arn:aws:lambda:ap-northeast-1:<acct>:layer:sharp:<ver>"
$env:FFMPEG_LAYER_ARN = "arn:aws:lambda:ap-northeast-1:<acct>:layer:ffmpeg:<ver>"
cdk deploy PhotoAlbum-Processing-dev
```

Layer 配備前にアップロードしたメディアは、投稿者がビューアの「再処理」で作り直せる。

## 未検証（実機確認が必要）

- iOS Safari / LINE内ブラウザでのファイル選択時の MIME・コーデック（`accept` に対応MIMEを列挙したときの HEIC→JPEG 変換を含む）
- 実S3への署名付きPUT・パートアップロード（チェックサム設定 `WHEN_REQUIRED` と Content-Type 署名の組み合わせ）
- 一時認証情報で署名したURLの実効期限、500MBオブジェクトの CopyObject 所要時間（削除・失効・再処理で使用）
- sharp/FFmpeg による実プレビュー生成とコーデック判定（Layer配備後に有効化）、`nodejs24.x` での実行
- 実ブラウザでの IndexedDB 保留・マルチパート並列アップロード・動画再生・Wake Lock

未対応・判断待ちの事項は `.kiro/specs/photo-album/tasks.md` のタスク19を参照。
```
