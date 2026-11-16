# 写真・動画共有アルバム（MVP）

LINEログインした利用者が、本人または所属グループ内だけで写真・動画をアルバムとして保管・閲覧・共有・コメントできるWebアプリ。

仕様は `.kiro/specs/photo-album/`（requirements / design / tasks）と `.kiro/steering/` を正とする。

## 構成（npm workspaces モノレポ）

```
shared/    フロント・バックエンド共有の型・定数・ULID
backend/   ドメイン(domain) → ストレージ(repo) → ユースケース(app) → HTTP(handlers) → 認証(auth)
frontend/  React + Vite。pages / components（ui=見た目の部品）/ styles（デザイントークン）/ features/upload / services / store
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

## デザインの変更方法（フロント）

見た目の値（色・書体・角丸・影・余白）は `frontend/src/styles/tokens.css` に集めている。画面や部品には色や角丸を直接書かず、このファイルの変数だけを参照する。

| 変えたいもの | 編集する場所 |
|---|---|
| 色・書体・角丸・影・余白 | `frontend/src/styles/tokens.css`。「2. 役割」の変数を変える（例はファイル冒頭のコメント） |
| ボタン・カードなど部品の形 | `frontend/src/components/ui/*.module.css` |
| 画面ごとの並べ方 | `frontend/src/pages/*.module.css`、`frontend/src/components/*.module.css` |
| アプリ名・ロゴの絵文字 | `frontend/src/brand.ts`。ブラウザのタブや LINE のリンクプレビューに出る名称は `frontend/index.html` の `<title>` |
| スマホのブラウザ上部の色・タブのアイコン | `frontend/index.html` の `theme-color`、`frontend/public/favicon.svg` |

- 画面は `frontend/src/components/ui`（Button / Card / Alert / Modal / Page など）を組み合わせて作る。新しい画面でも `style={{ ... }}` で色を直接書かない。
- CSS は CSS Modules（`*.module.css`、Vite 標準）。CSS フレームワークや外部の Web フォントは使わない（依存と通信量を増やさないため）。iPhone・Mac では丸ゴシック、それ以外の端末では標準のゴシック体で表示される。
- 例: 太い枠線と固い影をやめて柔らかい見た目にするなら、tokens.css で `--border-width: 1px;`・`--color-border: var(--palette-ink-300);` とし、`--shadow-pop`・`--shadow-pop-hover`・`--shadow-pop-lg` を `var(--shadow-soft)` にする。

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

> 本番環境（`https://d3gshsyo8qdxa8.cloudfront.net`）にデプロイ済み。デプロイは明示的な承認を得てから行う。

1. AWS 認証: `aws configure sso` → `aws sso login`（東京リージョン `ap-northeast-1`）
2. LINE Developers: チャネル作成、コールバックURL `https://<CloudFrontドメイン>/api/auth/line/callback` を登録
3. SSM Parameter Store に投入（SecureString）:
   - `/<env>/photo-album/cookie-secret`
   - `/<env>/photo-album/line-channel-id`
   - `/<env>/photo-album/line-channel-secret`
4. `cd infra; npx cdk diff --all` で意図しない差分（Layer の削除など）が無いか確認してから `npx cdk deploy --all`（Lambda は NodejsFunction が esbuild で自動バンドル）

デプロイ時の設定:

| 設定 | 置き場所（上が優先） | 本番の値 |
|---|---|---|
| 公開オリジン（CloudFront ドメイン。CORS・LINE コールバック・変更系 API の Origin 検証に使う） | 環境変数 `APP_ORIGIN` → `infra/cdk.json` の `photoAlbum:appOrigin` | `https://d3gshsyo8qdxa8.cloudfront.net` |
| FFmpeg Layer（写真・動画のプレビュー） | 環境変数 `FFMPEG_LAYER_ARN` → `infra/cdk.json` の `photoAlbum:ffmpegLayer`（`名前:バージョン`・Layer の ARN・`none`） | `ffmpeg:1` |
| API Gateway のスロットリング | 環境変数 `API_THROTTLE_RATE` / `API_THROTTLE_BURST` | 20 / 40 |
| 予算アラート | 環境変数 `MONTHLY_BUDGET_USD` / `BUDGET_NOTIFY_EMAIL` | 20 / なし |

- 公開オリジンと FFmpeg Layer の本番の値は `infra/cdk.json` で Git 管理しているので、環境変数を設定しなくても本番と同じ構成でデプロイされる。環境変数は一時的な上書き用。本番の値を変えるときは `infra/cdk.json` を書き換えてコミットする。
- FFmpeg Layer の指定が無いと synth・diff・deploy はエラーで止まる。以前は環境変数の設定漏れのままデプロイされて Layer が外れ、写真・動画のプレビューが作れなくなった（2026-11-16、tasks.md タスク24）。
- 新しい環境を作るときは、`photoAlbum:appOrigin` を空、`photoAlbum:ffmpegLayer` を `none` にして最初のデプロイを行い、CloudFront のドメインと FFmpeg Layer ができたら値を入れて再デプロイする。
- 1つのスタックだけを更新するときは `--exclusively` を付ける（付けないと依存する下位のスタックも更新される）。スタック依存は `Storage → Processing → AuthApi → Delivery`。

## プレビュー（FFmpeg）の有効化

サムネイル生成Lambdaは写真・動画とも FFmpeg / ffprobe を使う。ネイティブバイナリ（linux-x64）のため
**バンドルに含めず Lambda Layer で供給する**（開発機に WSL2/Docker が無くてもデプロイできるようにするため）。
未供給の間、該当メディアは `error(preview_failed)` になり一般の一覧には出ない（投稿者には「再処理」ボタンが出る）。

- FFmpeg: `/opt/bin/ffmpeg` と `/opt/bin/ffprobe` を含む Layer（パスが異なる場合は Lambda の環境変数 `FFMPEG_PATH` / `FFPROBE_PATH`）。HTTPS 入力に対応したビルドが必要

Layer を作り直した（バージョンが上がった）ときは、`infra/cdk.json` の `photoAlbum:ffmpegLayer` を `ffmpeg:<新しいバージョン>` に書き換えてコミットし、処理系スタックだけをデプロイする。

```
cd infra
npx cdk diff PhotoAlbum-Processing-dev --exclusively     # Layer の変更だけか確認
npx cdk deploy PhotoAlbum-Processing-dev --exclusively
```

Layer が無い間にアップロードしたメディアは、投稿者がビューアの「再処理」で作り直せる。

## 未検証（実機確認が必要）

- iOS Safari / LINE内ブラウザでのファイル選択時の MIME・コーデック（`accept` に対応MIMEを列挙したときの HEIC→JPEG 変換を含む）
- 一時認証情報で署名したURLの実効期限、500MBオブジェクトの CopyObject 所要時間（削除・失効・再処理で使用）
- FFmpeg（ffprobe）による動画のコーデック判定（写真のプレビュー生成と `nodejs24.x` での実行は本番で確認済み）
- 実ブラウザでの IndexedDB 保留・マルチパート並列アップロード・動画再生・Wake Lock

未対応・判断待ちの事項は `.kiro/specs/photo-album/tasks.md` のタスク19を参照。
```

> **注意**: 招待制の新規登録（タスク22）を実装・デプロイするまで、LINEログインチャネルを「公開」にしないこと。
