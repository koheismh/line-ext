// ListObjectsV2 によるプレフィックス一覧（repo層）。
// 時刻順IDをキーに使うため、辞書順＝登録日時昇順になる。

import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { s3 } from './s3Client.js';
import { getJson } from './jsonStore.js';

/** プレフィックス配下のキー一覧（ページング対応）。 */
export async function listKeys(
  bucket: string,
  prefix: string,
  opts?: { maxKeys?: number; continuationToken?: string },
): Promise<{ keys: string[]; nextToken?: string }> {
  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ...(opts?.maxKeys ? { MaxKeys: opts.maxKeys } : {}),
      ...(opts?.continuationToken ? { ContinuationToken: opts.continuationToken } : {}),
    }),
  );
  const keys = (res.Contents ?? []).map((o) => o.Key!).filter(Boolean);
  return {
    keys,
    ...(res.IsTruncated && res.NextContinuationToken
      ? { nextToken: res.NextContinuationToken }
      : {}),
  };
}

/**
 * プレフィックス配下のJSONをすべて読み込む（小規模コレクション向け）。
 * 大規模はページングAPIを別途使う。
 */
export async function listJson<T>(bucket: string, prefix: string): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const page = await listKeys(bucket, prefix, token ? { continuationToken: token } : undefined);
    const items = await Promise.all(page.keys.map((k) => getJson<T>(bucket, k)));
    for (const it of items) {
      if (it) out.push(it.value);
    }
    token = page.nextToken;
  } while (token);
  return out;
}
