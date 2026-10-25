# 写真・動画共有アルバム — MVP構成案 v0.2

更新日: 2026-10-18
状態: 暫定設計。初回実装タスクで妥当性を検証する。

## 1. 最小構成
- フロントエンド: React + TypeScript + Vite。スマホ優先のレスポンシブUI。
- ホスティング: 非公開S3（静的アセット）+ CloudFront（HTTPS、Origin Access Control）。独自ドメインは後回し。
- API: CloudFrontの `/api/*` を API Gateway HTTP API → Lambdaへ転送。同一オリジンでセッションCookieを扱い、APIはキャッシュ無効。
- 認証: LINE Login v2.1 OIDC、サーバサイド認可コードフロー、state／nonce／PKCE。
- バックエンド: Lambda + TypeScript（Node.jsの現行サポートLTS）。
- メタデータ: 原則S3 JSON。メディア: 別の非公開S3バケット。
- サムネイル: S3アップロード完了イベント起点のLambda。写真はSharp等、動画はFFmpegをパッケージ化したLambda等で冒頭フレーム取得。
- IaC: AWS CDK（TypeScript）。全リソースはコード管理。
- 秘密情報: SSM Parameter Store SecureStringなどの安全な保管先。認証秘密鍵・LINE Channel SecretはフロントやGitに絶対渡さない。

## 2. アップロードと表示
1. ログイン済みクライアントがアルバム内でファイルを選択。
2. Lambdaがメンバーシップ・申告された形式・容量をチェックし、容量制限付きのS3署名付きPOST（または同等に制限可能な方式）とmediaIdを返す。
3. ブラウザがS3へ直接アップロードする。S3のCORSは必要最小限のOrigin／Method／Headerに制限。
4. S3イベントでLambdaが実容量とファイルの実形式を検査し、サムネイルを作成して `ready` に更新する。検証失敗は公開せずエラー状態にする。
5. 一覧はサムネイルだけ表示し、原本URLは表示操作ごとに権限確認をして発行する。
6. 大量ファイルや同時実行が増えたらキュー方式に移行する。MVPはイベント重複・順序不定に対応できる冪等性を持たせる。

## 3. S3レイアウト案
### 非公開メタデータバケット
```
users/{userId}.json
identities/line/{sha256OfLineSub}.json
user-groups/{userId}/{groupId}.json        # 検索用、認可判定の正本ではない
groups/{groupId}.json                       # メンバーIDが正本
invites/{sha256OfInviteToken}.json
albums/{ownerType}/{ownerId}/{albumId}.json
media/{albumId}/{mediaId}.json
comments/{targetType}/{targetId}/{rootCommentId}/{commentId}.json
```
- `ownerType` は `user` / `group`。
- ユーザーごとのグループ一覧は `user-groups/` を使って取得後、必ず `groups/{groupId}.json` と照合。
- アルバム参照APIには所有主体（ownerType、ownerId）も渡す。匿名ユーザーによるID推測は関係なく、サーバの認可で拒否。
- メディアは必ず `albumId` を通して正本のアルバムへ辿り、所有権を検証する。
- コメントは1コメント1JSON。対象配下をListObjectsV2でページングして取得し、root単位で並べる。
- グループ、アルバムのJSON更新にはETagベースの条件付き書き込みを使い、競合は409で返してリトライできるようにする。
- 複数キー更新はトランザクションでない。正本と検索用インデックスを区別して再実行・修復できる構成にする。

### 非公開メディアバケット
```
originals/{albumId}/{mediaId}/source.{ext}
previews/{albumId}/{mediaId}/thumbnail.jpg
trash/{deletedDate}/{albumId}/{mediaId}/source.{ext}
trash/{deletedDate}/{albumId}/{mediaId}/thumbnail.jpg
```
- `trash/` プレフィックスにLifecycle: Expiration 30日（暫定）。
- `originals/` / `previews/` に削除ルールを誤適用しない。
- バージョニングは初期状態では無効（暫定）。将来有効化する際は非現行バージョン期限も要設定。
- アップロード上限を500MBに抑え、単一CopyObjectの5GB上限内とする。

### 静的フロントエンドバケット
```
index.html
assets/*
```
- S3 Website Hostingではなく、通常の非公開S3をCloudFrontからOAC経由で参照する。

## 4. 削除状態遷移
`ready -> deleting -> trashed` とし、重複呼び出しは冪等に成功させる。
- `deleting` を正本メタデータに保存してから、原本とプレビューを `trash/` へコピーする。
- コピーできたオブジェクトをHEADなどで検査してから元を削除し、すべて成功したら `trashed` を確定する。
- 途中失敗では状態を残し、再実行可能な操作にする。データ消失を防ぐため、コピー検証前に元ファイルを削除しない。
- 削除したメディアは検索結果、表紙、URL発行対象から除外。既発行の署名付きURLは満了まで利用可能なため短命にする。
- 将来の復元向けに、削除時の移動キーと削除日時をJSONに保存。

## 5. アカウント認証と認可
- LINE callbackは `https://<CloudFrontホスト>/api/auth/line/callback` のようなHTTPSをLINE Developersに登録する。
- トークン交換はLambdaで実施。取得したOIDC IDトークンの署名・issuer・audience・nonce・期限を検証。
- LINEのsubjectと内部userIdの対応をS3 JSONに記録。初回ログイン時はアカウント生成。
- セッションは改ざん検証可能な署名付きCookie（HttpOnly、Secure、SameSite=Lax）等で保持。期限設定とログアウトを実装。
- `GET /api/auth/line/start`、`GET /api/auth/line/callback` 以外は認証必須（公開ヘルスチェック等を除く）。
- 変更系APIではOrigin／CSRF対策を実施。API GatewayやCloudFrontで `Set-Cookie` と `Cookie` を適切に転送し、APIのキャッシュを無効にする。
- 管理者権限の有無・所属グループはAPI内で毎回検査。

## 6. APIの初期境界（HTTPパス案）
```
GET  /api/me
GET  /api/auth/line/start
GET  /api/auth/line/callback
POST /api/auth/logout
GET  /api/groups
POST /api/groups
POST /api/groups/{groupId}/invites
POST /api/invites/accept
GET  /api/albums?ownerType=user|group&ownerId=...
POST /api/albums
GET  /api/albums/{albumId}?ownerType=...&ownerId=...
PATCH /api/albums/{albumId}
GET  /api/albums/{albumId}/media
POST /api/albums/{albumId}/media/uploads
GET  /api/media/{mediaId}/url?kind=preview|original
DELETE /api/media/{mediaId}
GET  /api/comments?targetType=album|media&targetId=...
POST /api/comments
DELETE /api/comments/{commentId}
```
- 上記は境界案。特に単独 `mediaId` / `commentId` で正本を引けるよう、APIルートに `albumId` や対象所有主体を追加するか、権限安全なlocator indexを作るかをTask 001で確定する。スキャンを前提にしない。
- JSON型とエラー型をフロント・バックエンドで共有する。

## 7. 費用と拡張性
- まずS3 JSONで始める。性能・同時更新・ページングに問題が出たら、メンバーシップやコメントなど整合性が重要なものをDynamoDBへ段階移行する。
- CDKに予算アラート（AWS Budgets）、ログ保存期間、危険なパブリック公開を防ぐ設定を組み込む。Budgets通知は設定条件により追加費用があり得る。
- 保管費用以上に、画像・動画のダウンロード転送量やプレビュー生成のコストを確認する。
- S3 Lifecycleは日数単位、実際の削除処理は非同期。厳密な秒単位の削除期限は要件外。

## 8. 公式資料
- AWS S3 CopyObject・移動: https://docs.aws.amazon.com/AmazonS3/latest/userguide/copy-object.html
- AWS S3 Lifecycle: https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html
- LINE Login v2.1: https://developers.line.biz/ja/docs/line-login/integrate-line-login/
- LINEセキュリティ: https://developers.line.biz/en/docs/line-login/security-checklist/
