// S3クライアントの生成を1か所に集約。リージョンは東京。
// テストでは aws-sdk-client-mock がこのクライアントをモックする。

import { S3Client } from '@aws-sdk/client-s3';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';

export const s3 = new S3Client({ region: REGION });
