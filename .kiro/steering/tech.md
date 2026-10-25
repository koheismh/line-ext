# 技術スタック・環境

言語はフロント・バックエンド・IaCすべて TypeScript で統一する。

## スタック
- フロントエンド: React + TypeScript + Vite。スマホ優先のレスポンシブUI。
- ホスティング: 非公開S3（静的アセット）+ CloudFront（HTTPS、Origin Access Control）。独自ドメインは後回し。
- API: CloudFront の `/api/*` を API Gateway HTTP API → Lambda へ転送。同一オリジンでセッションCookieを扱い、APIはキャッシュ無効。
- 認証: LINE Login v2.1 OIDC。サーバサイド認可コードフロー（state / nonce / PKCE）。
- バックエンド: Lambda + TypeScript（Node.js の現行サポートLTS）。
- メタデータ: 原則 S3 JSON。メディア: 別の非公開S3バケット。
- サムネイル: S3アップロード完了イベント起点のLambda。写真はSharp等、動画はFFmpegをパッケージ化したLambda等で冒頭フレーム取得。
- IaC: AWS CDK（TypeScript）。全リソースをコード管理。
- 秘密情報: SSM Parameter Store SecureString 等。認証秘密鍵・LINE Channel Secret はフロントやGitに絶対渡さない。

## デプロイ環境
- リージョン: `ap-northeast-1`（東京）。
- ローカルからのデプロイは AWS IAM Identity Center（SSO）の一時認証情報を使う。長期アクセスキーをローカルに保存しない。
  - 初回のみ `aws configure sso` で対話セットアップ。以降は `aws sso login` で一時認証情報を取得してCDKデプロイ・S3操作に使う。
- 本番デプロイ、課金サービスの追加、削除対象バケットの破壊は明示的な許可があるまで行わない。

## 状態管理・ルーティング（フロント）
- 追加の月額課金が発生しない構成を優先する。外部SaaS・有料サービスに依存しない。
- ルーティングは React Router。状態管理は標準の React Context / hooks を基本とし、必要が明確になった時点でのみ軽量ライブラリ（Zustand等）を検討する。
- 型（JSON型・エラー型）はフロント・バックエンドで共有する。

## 費用・拡張性の方針
- まず S3 JSON で始める。性能・同時更新・ページングに問題が出たら、メンバーシップやコメントなど整合性が重要なものから DynamoDB へ段階移行する。
- CDK に予算アラート（AWS Budgets）、ログ保存期間、危険なパブリック公開を防ぐ設定を組み込む。
- 保管費用以上に、画像・動画のダウンロード転送量やプレビュー生成コストを確認する。
