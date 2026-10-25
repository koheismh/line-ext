// メディアバケットのオブジェクトIO（repo層）。
// 署名付きURL発行（用途別期限・同一URL再利用キャッシュ）、CopyObject、
// サイズ検証(HeadObject)、DeleteObject、ListParts。

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListPartsCommand,
  type S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SIGNED_URL_TTL_SECONDS, type SignedUrlKind } from '@photo-album/shared';
import { s3 } from './s3Client.js';

/**
 * 署名付きURLの簡易キャッシュ。
 * 同一(key,kind)は有効期限内は同一URLを再利用する（ブラウザキャッシュを効かせ転送量を抑える）。
 * Lambda実行環境のメモリ上キャッシュ。期限の8割で切れるものとして扱い安全側に倒す。
 */
interface CacheEntry {
  url: string;
  expiresAtMs: number;
}
const urlCache = new Map<string, CacheEntry>();

function cacheKey(bucket: string, key: string, kind: SignedUrlKind): string {
  return `${kind}:${bucket}/${key}`;
}

/** テスト用にキャッシュを明示クリアする。 */
export function clearSignedUrlCache(): void {
  urlCache.clear();
}

/**
 * 参照用の署名付きURLを発行する（preview/original/video/download）。
 * - 同一(key,kind)は有効期限内で再利用
 * - original: 検証済みMIMEで ResponseContentType を上書き
 * - download: attachment を付与
 */
export async function getReadSignedUrl(params: {
  bucket: string;
  key: string;
  kind: SignedUrlKind;
  contentType?: string;
  downloadFileName?: string;
}): Promise<string> {
  const { bucket, key, kind, contentType, downloadFileName } = params;
  const ttl = SIGNED_URL_TTL_SECONDS[kind];
  const ck = cacheKey(bucket, key, kind);
  const now = Date.now();

  const cached = urlCache.get(ck);
  if (cached && cached.expiresAtMs > now) {
    return cached.url;
  }

  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(contentType ? { ResponseContentType: contentType } : {}),
    ...(kind === 'download'
      ? {
          ResponseContentDisposition: `attachment${
            downloadFileName ? `; filename="${encodeURIComponent(downloadFileName)}"` : ''
          }`,
        }
      : {}),
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: ttl });

  // 期限の8割をキャッシュ有効期限とする（安全側）
  urlCache.set(ck, { url, expiresAtMs: now + ttl * 1000 * 0.8 });
  return url;
}

/**
 * 単一PUTアップロード用の署名付きURL。
 * Content-Length と Content-Type を署名に含め、申告と異なるアップロードをS3段階で拒否させる。
 */
export async function getUploadSignedUrl(params: {
  bucket: string;
  key: string;
  contentType: string;
  contentLength: number;
  expiresIn: number;
}): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: params.bucket,
    Key: params.key,
    ContentType: params.contentType,
    ContentLength: params.contentLength,
  });
  return getSignedUrl(s3, cmd, { expiresIn: params.expiresIn });
}

/** オブジェクトのサイズを取得する。存在しなければ null。 */
export async function headObjectSize(bucket: string, key: string): Promise<number | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return res.ContentLength ?? null;
  } catch (err) {
    const status = (err as S3ServiceException)?.$metadata?.httpStatusCode;
    if (status === 404 || (err as { name?: string })?.name === 'NotFound') {
      return null;
    }
    throw err;
  }
}

/** オブジェクトをコピーする（ごみ箱退避など）。 */
export async function copyObject(
  bucket: string,
  fromKey: string,
  toKey: string,
): Promise<void> {
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(fromKey)}`,
      Key: toKey,
    }),
  );
}

/**
 * コピー先をサイズで検証する（ETag一致は検証条件にしない：マルチパート原本のETagはコピー後と一致しないため）。
 * @returns 検証成功なら true
 */
export async function verifyCopiedBySize(
  bucket: string,
  fromKey: string,
  toKey: string,
): Promise<boolean> {
  const [src, dst] = await Promise.all([
    headObjectSize(bucket, fromKey),
    headObjectSize(bucket, toKey),
  ]);
  return src !== null && dst !== null && src === dst;
}

/** オブジェクトを削除する（冪等：存在しなくても成功扱い）。 */
export async function deleteObject(bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** マルチパートの合計サイズを ListParts で取得する（complete前の検証用）。 */
export async function sumUploadedParts(
  bucket: string,
  key: string,
  uploadId: string,
): Promise<number> {
  let total = 0;
  let partNumberMarker: string | undefined;
  // ページング（1000パート超に対応）
  do {
    const res = await s3.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        ...(partNumberMarker ? { PartNumberMarker: partNumberMarker } : {}),
      }),
    );
    for (const p of res.Parts ?? []) {
      total += p.Size ?? 0;
    }
    partNumberMarker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
  } while (partNumberMarker);
  return total;
}

// ---- マルチパートアップロード ----

import {
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

/** マルチパートアップロードを開始し uploadId を返す。 */
export async function createMultipartUpload(params: {
  bucket: string;
  key: string;
  contentType: string;
}): Promise<string> {
  const res = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: params.bucket,
      Key: params.key,
      ContentType: params.contentType,
    }),
  );
  if (!res.UploadId) throw new Error('UploadId を取得できませんでした。');
  return res.UploadId;
}

/** 指定パート番号群の UploadPart 用署名付きURLを発行する。 */
export async function getPartUploadUrls(params: {
  bucket: string;
  key: string;
  uploadId: string;
  partNumbers: number[];
  expiresIn: number;
}): Promise<{ partNumber: number; url: string }[]> {
  return Promise.all(
    params.partNumbers.map(async (partNumber) => {
      const cmd = new UploadPartCommand({
        Bucket: params.bucket,
        Key: params.key,
        UploadId: params.uploadId,
        PartNumber: partNumber,
      });
      const url = await getSignedUrl(s3, cmd, { expiresIn: params.expiresIn });
      return { partNumber, url };
    }),
  );
}

/** マルチパートを完了する。parts はクライアント申告の ETag/PartNumber。 */
export async function completeMultipartUpload(params: {
  bucket: string;
  key: string;
  uploadId: string;
  parts: { partNumber: number; etag: string }[];
}): Promise<void> {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: params.bucket,
      Key: params.key,
      UploadId: params.uploadId,
      MultipartUpload: {
        Parts: params.parts
          .slice()
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
}

/** マルチパートを中断する（失効・取り消し時の片付け）。 */
export async function abortMultipartUpload(params: {
  bucket: string;
  key: string;
  uploadId: string;
}): Promise<void> {
  await s3.send(
    new AbortMultipartUploadCommand({
      Bucket: params.bucket,
      Key: params.key,
      UploadId: params.uploadId,
    }),
  );
}
