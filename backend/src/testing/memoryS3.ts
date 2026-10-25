// テスト用のインメモリS3モック。
// GetObject / PutObject(条件付き) / ListObjectsV2 を再現する。
// aws-sdk-client-mock と組み合わせて app/repo の結合テストに使う。

import { mockClient } from 'aws-sdk-client-mock';
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

export interface MemoryS3 {
  store: Map<string, { body: string; etag: string }>;
  reset: () => void;
  /** キーに直接JSONを置く（シード用）。 */
  put: (key: string, value: unknown) => void;
  get: (key: string) => unknown | undefined;
  has: (key: string) => boolean;
  /** マルチパートの uploadId に対応するパートサイズ群を設定する（ListParts用）。 */
  setParts: (uploadId: string, partSizes: number[]) => void;
}

export function installMemoryS3(client: S3Client): MemoryS3 {
  const m = mockClient(client);
  const store = new Map<string, { body: string; etag: string }>();
  const uploads = new Map<string, number[]>();
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

    m.on(ListObjectsV2Command).callsFake((input) => {
      const prefix = (input.Prefix as string) ?? '';
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
    });

    // ---- マルチパート（テスト用の簡易再現）----
    m.on(CreateMultipartUploadCommand).callsFake(() => {
      const uploadId = `upload-${++seq}`;
      uploads.set(uploadId, []);
      return { UploadId: uploadId };
    });
    m.on(ListPartsCommand).callsFake((input) => {
      const parts = uploads.get(input.UploadId as string) ?? [];
      return {
        Parts: parts.map((size, i) => ({ PartNumber: i + 1, Size: size })),
        IsTruncated: false,
      };
    });
    m.on(CompleteMultipartUploadCommand).callsFake((input) => {
      // 完了したらオブジェクトが存在することにする（サイズは合計）
      const parts = uploads.get(input.UploadId as string) ?? [];
      const total = parts.reduce((a, b) => a + b, 0);
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
  };
}
