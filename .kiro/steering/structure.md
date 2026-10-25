# 構成・S3レイアウト・API境界

## CDKスタック分割
拡張を見据え、責務ごとにスタックを分割する（1スタックにまとめない）。目安:
- ストレージ系（メタデータ/メディア/静的フロントの各S3バケット、Lifecycle、Budgets）
- 配信系（CloudFront + OAC、`/api/*` ルーティング）
- API/認証系（API Gateway HTTP API、Lambda、権限）
- 処理系（サムネイル生成Lambda、S3イベント連携）
スタック間の参照は循環しないよう、下位（ストレージ）→上位（配信・API）の一方向にする。

## S3レイアウト

### 非公開メタデータバケット
```
users/{userId}.json
identities/line/{sha256OfLineSub}.json
user-groups/{userId}/{groupId}.json        # 検索用。認可判定の正本ではない
groups/{groupId}.json                       # メンバーIDが正本
invites/{sha256OfInviteToken}.json
albums/{ownerType}/{ownerId}/{albumId}.json
media/{albumId}/{mediaId}.json
comments/{targetType}/{targetId}/{rootCommentId}/{commentId}.json
```
- `ownerType` は `user` / `group`。
- ユーザーごとのグループ一覧は `user-groups/` で取得後、必ず `groups/{groupId}.json` と照合する。
- メディアは必ず `albumId` を通して正本アルバムへ辿り、所有権を検証する。
- コメントは1コメント1JSON。対象配下を ListObjectsV2 でページングし root 単位で並べる。
- グループ・アルバムのJSON更新は ETag ベースの条件付き書き込み。競合は 409 で返しリトライ可能にする。
- 複数キー更新はトランザクションでない。正本と検索用インデックスを区別し、再実行・修復できる構成にする。

### 非公開メディアバケット
```
originals/{albumId}/{mediaId}/source.{ext}
previews/{albumId}/{mediaId}/thumbnail.jpg
trash/{deletedDate}/{albumId}/{mediaId}/source.{ext}
trash/{deletedDate}/{albumId}/{mediaId}/thumbnail.jpg
```
- `trash/` にのみ Lifecycle Expiration 30日（暫定、CDK設定で変更可能）。
- `originals/` / `previews/` に削除ルールを誤適用しない。
- バージョニングは初期無効（暫定）。将来有効化時は非現行バージョン期限も設定する。
- 動画500MB想定。ごみ箱退避のコピーは単一 CopyObject の5GB上限内に収める。
- アップロードはマルチパートに対応する（下記）。未完了マルチパートは Lifecycle `AbortIncompleteMultipartUpload`（暫定1日）で破棄し、保管コストを残さない。

### 静的フロントエンドバケット
```
index.html
assets/*
```
- S3 Website Hosting ではなく、非公開S3を CloudFront から OAC 経由で参照する。

## API境界（HTTPパス案）
```
GET    /api/me
GET    /api/auth/line/start                     # 戻り先(同一オリジン相対)を保持
GET    /api/auth/line/callback
POST   /api/auth/logout                         # sessionVersion をインクリメントし全Cookie無効化
GET    /api/groups
POST   /api/groups                              # name 必須
GET    /api/groups/{groupId}                    # グループ詳細（メンバー表示名一覧を含む）
POST   /api/groups/{groupId}/invites            # 管理者のみ
POST   /api/invites/{inviteId}/revoke           # 招待失効（管理者のみ）
POST   /api/invites/accept                      # 明示操作で参加
GET    /api/albums                              # 権限のある所有主体のみ。所有主体はクエリ省略可(locatorで解決)
POST   /api/albums
GET    /api/albums/{albumId}                    # album-locator で所有主体を解決
PATCH  /api/albums/{albumId}
GET    /api/albums/{albumId}/media              # ready のみ・プレビューURLをまとめて返す・ページング
POST   /api/albums/{albumId}/media/uploads          # 単一PUT署名URL（Content-Length/Type を署名）+ mediaId
POST   /api/albums/{albumId}/media/uploads/multipart # マルチパート開始 → uploadId + パート署名URL群
POST   /api/media/{mediaId}/uploads/{uploadId}/parts # パート署名URLの再発行（期限切れ対策）
POST   /api/media/{mediaId}/uploads/{uploadId}/complete # ListParts検証 → CompleteMultipartUpload
GET    /api/media/{mediaId}/url?kind=preview|original|video|download # 用途別に期限が異なる
DELETE /api/media/{mediaId}                     # deleting にして 202、削除は非同期ワーカー
GET    /api/comments?targetType=album|media&targetId=... # root単位ページング
POST   /api/comments
DELETE /api/comments/{commentId}
```
- 単独 `mediaId`/`commentId`/`albumId` は locator index（`media-locator`/`comment-locator`/`album-locator`）で正本へ解決してから認可する。ListObjects スキャンを前提にしない。
- 署名付きURLは用途別に期限を分ける（プレビュー1h / 写真原本5分 / 動画再生30分, 暫定）。同一メディアは有効期限内で同一URLを再利用する。
- 閲覧権限のない参照は404（存在を推測させない）。操作権限なしのみ403。

## レイヤリング
ドメインロジック、認証認可、ストレージIO、HTTP処理を分割する。S3 JSON のパスを画面側に漏らさない。
