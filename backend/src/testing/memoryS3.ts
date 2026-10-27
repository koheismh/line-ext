// テスト用のインメモリS3モック。
// GetObject / PutObject(条件付き) / ListObjectsV2(Delimiter・ページング) / マルチパート / Copy / Delete / Head を再現する。
// aws-sdk-client-mock と組み合わせて app/repo の結合テストに使う。

import { mockClient, type AwsStub } from 'aws-sdk-client-mock';
import {
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type S3Stub = AwsStub<any, any, any>;

export interface MemoryS3 {
  store: Map<string, { body: string; etag: string }>;
  reset: () => void;
  /** キーに直接JSONを置く（シード用）。 */
  put: (key: string, value: unknown) => void;
  get: (key: string) => unknown | undefined;
  has: (key: string) => boolean;
  /** マルチパートの uploadId に対応するパートサイズ群を設定する（ListParts用）。 */
  setParts: (uploadId: string, partSizes: number[]) => void;
  /** CompleteMultipartUpload に渡されたパート（uploadId → パート一覧）。 */
  completed: Map<string, { PartNumber?: number; ETag?: string }[]>;
  /** 個別の挙動を上書きしたいテスト用の生モック。 */
  mock: S3Stub;
}

export function installMemoryS3(client: S3Client): MemoryS3 {
  const m = mockClient(client);
  const store = new Map<string, { body: string; etag: string }>();
  const uploads = new Map<string, number[]>();
  const completed = new Map<string, { PartNumber?: number; ETag?: string }[]>();
  let seq = 0;

  function configure() {
    m.reset();

    m.on(GetObjectCommand).callsFake((input) => {
      const rec = store.get(input.Key as string);
      if (!rec) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => rec.body }, ETag: `"${rec.etag}"` };
    });

    m.on(PutObjectCommand).callsFake((input) => {
      const key = input.Key as string;
      const existing = store.get(key);
      if (input.IfNoneMatch === '*' && existing) {
        throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
      }
      if (input.IfMatch) {
        const want = String(input.IfMatch).replaceAll('"', '');
        if (!existing || existing.etag !== want) {
          throw Object.assign(new Error('PreconditionFailed'), {
            $metadata: { httpStatusCode: 412 },
          });
        }
      }
      const etag = `e${++seq}`;
      store.set(key, { body: String(input.Body), etag });
      return { ETag: `"${etag}"` };
    });

    // ListObjectsV2: Prefix / Delimiter / MaxKeys / ContinuationToken を再現する
    m.on(ListObjectsV2Command).callsFake((input) => {
      const prefix = (input.Prefix as string) ?? '';
      const delimiter = input.Delimiter as string | undefined;
      const maxKeys = (input.MaxKeys as number | undefined) ?? 1000;
      const after = input.ContinuationToken as string | undefined;

      const entries: { key?: string; prefix?: string; sortKey: string }[] = [];
      const seenPrefixes = new Set<string>();
      for (const k of [...store.keys()].filter((x) => x.startsWith(prefix)).sort()) {
        if (delimiter) {
          const rest = k.slice(prefix.length);
          const idx = rest.indexOf(delimiter);
          if (idx >= 0) {
            const p = prefix + rest.slice(0, idx + delimiter.length);
            if (!seenPrefixes.has(p)) {
              seenPrefixes.add(p);
              entries.push({ prefix: p, sortKey: p });
            }
            continue;
          }
        }
        entries.push({ key: k, sortKey: k });
      }
      entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

      let start = 0;
      if (after) {
        const idx = entries.findIndex((e) => e.sortKey > after);
        start = idx === -1 ? entries.length : idx;
      }
      const page = entries.slice(start, start + maxKeys);
      const truncated = start + maxKeys < entries.length;
      return {
        Contents: page.filter((e) => e.key).map((e) => ({ Key: e.key })),
        CommonPrefixes: page.filter((e) => e.prefix).map((e) => ({ Prefix: e.prefix })),
        IsTruncated: truncated,
        ...(truncated ? { NextContinuationToken: page[page.length - 1]!.sortKey } : {}),
      };
    });

    // ---- マルチパート（テスト用の簡易再現）----
    m.on(CreateMultipartUploadCommand).callsFake(() => {
      const uploadId = `upload-${++seq}`;
      uploads.set(uploadId, []);
      return { UploadId: uploadId };
    });
    m.on(ListPartsCommand).callsFake((input) => {
      const uploadId = input.UploadId as string;
      if (!uploads.has(uploadId)) {
        throw Object.assign(new Error('NoSuchUpload'), {
          name: 'NoSuchUpload',
          $metadata: { httpStatusCode: 404 },
        });
      }
      const parts = uploads.get(uploadId) ?? [];
      return {
        Parts: parts.map((size, i) => ({ PartNumber: i + 1, Size: size, ETag: `"etag-${i + 1}"` })),
        IsTruncated: false,
      };
    });
    m.on(CompleteMultipartUploadCommand).callsFake((input) => {
      // 完了したらオブジェクトが存在することにする（サイズは合計）
      const uploadId = input.UploadId as string;
      const parts = uploads.get(uploadId) ?? [];
      const total = parts.reduce((a, b) => a + b, 0);
      completed.set(uploadId, input.MultipartUpload?.Parts ?? []);
      uploads.delete(uploadId);
      store.set(input.Key as string, { body: `MULTIPART:${total}`, etag: `e${++seq}` });
      return { ETag: `"e${seq}"` };
    });
    m.on(AbortMultipartUploadCommand).callsFake((input) => {
      uploads.delete(input.UploadId as string);
      return {};
    });

    // ---- オブジェクト操作（コピー・削除・Head）----
    m.on(HeadObjectCommand).callsFake((input) => {
      const rec = store.get(input.Key as string);
      if (!rec) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
      return { ContentLength: rec.body.length };
    });
    m.on(CopyObjectCommand).callsFake((input) => {
      // CopySource は "bucket/urlencodedKey"
      const src = decodeURIComponent(String(input.CopySource).split('/').slice(1).join('/'));
      const rec = store.get(src);
      if (!rec) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      store.set(input.Key as string, { body: rec.body, etag: `e${++seq}` });
      return {};
    });
    m.on(DeleteObjectCommand).callsFake((input) => {
      store.delete(input.Key as string);
      return {};
    });
  }

  configure();

  return {
    store,
    reset: () => {
      store.clear();
      uploads.clear();
      completed.clear();
      seq = 0;
      configure();
    },
    put: (key, value) => {
      store.set(key, { body: JSON.stringify(value), etag: `seed-${++seq}` });
    },
    get: (key) => {
      const rec = store.get(key);
      return rec ? JSON.parse(rec.body) : undefined;
    },
    has: (key) => store.has(key),
    setParts: (uploadId, partSizes) => {
      uploads.set(uploadId, partSizes);
    },
    completed,
    mock: m,
  };
}
