// S3クライアントの生成を1か所に集約。リージョンは東京。
// テストでは aws-sdk-client-mock がこのクライアントをモックする。
//
// チェックサム設定（design.md「未確定事項」で確認対象だった点）:
// SDK v3（3.729.0以降）は既定でアップロードに CRC32 を自動付与する。署名付きURLでは本文が無い状態で
// 計算されるため `x-amz-checksum-crc32=AAAAAA==`（空データのCRC32）が URL に固定で埋め込まれ、
// ブラウザが実ファイルを送ると不一致になり得る。必須の操作に限ってチェックサムを付ける設定にする。

import { S3Client } from '@aws-sdk/client-s3';

const REGION = process.env.AWS_REGION ?? 'ap-northeast-1';

export const s3 = new S3Client({
  region: REGION,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
