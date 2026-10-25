// S3 JSON の読み書き（repo層の基盤）。
// - ETag条件付き書き込み（If-Match）で楽観ロック。競合は ConflictError。
// - 新規作成（If-None-Match:*）。既存なら AlreadyExistsError。
// S3は条件付き書き込み（IfMatch / IfNoneMatch）をサポートする。

import {
  GetObjectCommand,
  PutObjectCommand,
  type S3ServiceException,
} from '@aws-sdk/client-s3';
import { s3 } from './s3Client.js';
import { ConflictError, NotFoundError, AlreadyExistsError } from './errors.js';

/** 読み出し結果。ETagは条件付き更新に使う。 */
export interface JsonRecord<T> {
  value: T;
  etag: string;
}

function isStatus(err: unknown, codes: number[]): boolean {
  const e = err as S3ServiceException;
  const status = e?.$metadata?.httpStatusCode;
  return typeof status === 'number' && codes.includes(status);
}

function errorName(err: unknown): string | undefined {
  return (err as { name?: string })?.name;
}

/**
 * JSONを取得する。存在しなければ null。
 */
export async function getJson<T>(bucket: string, key: string): Promise<JsonRecord<T> | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await res.Body!.transformToString('utf-8');
    const etag = (res.ETag ?? '').replaceAll('"', '');
    return { value: JSON.parse(text) as T, etag };
  } catch (err) {
    if (errorName(err) === 'NoSuchKey' || isStatus(err, [404])) {
      return null;
    }
    throw err;
  }
}

/**
 * JSONを取得する。存在しなければ NotFoundError。
 */
export async function getJsonOrThrow<T>(bucket: string, key: string): Promise<JsonRecord<T>> {
  const rec = await getJson<T>(bucket, key);
  if (rec === null) throw new NotFoundError();
  return rec;
}

/**
 * 既存JSONをETag条件付きで更新する。
 * @param expectedEtag getJson で取得したETag。競合時は ConflictError。
 * @returns 新しいETag
 */
export async function putJsonIfMatch<T>(
  bucket: string,
  key: string,
  value: T,
  expectedEtag: string,
): Promise<string> {
  try {
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: 'application/json',
        IfMatch: `"${expectedEtag}"`,
      }),
    );
    return (res.ETag ?? '').replaceAll('"', '');
  } catch (err) {
    // 412 Precondition Failed = ETag不一致（競合）
    if (isStatus(err, [412, 409]) || errorName(err) === 'PreconditionFailed') {
      throw new ConflictError();
    }
    throw err;
  }
}

/**
 * JSONを新規作成する（If-None-Match:*）。既に存在すれば AlreadyExistsError。
 * 初回ログインのユーザー/identity、招待、各locatorの二重作成防止に使う。
 * @returns 新しいETag
 */
export async function putJsonIfAbsent<T>(
  bucket: string,
  key: string,
  value: T,
): Promise<string> {
  try {
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: 'application/json',
        IfNoneMatch: '*',
      }),
    );
    return (res.ETag ?? '').replaceAll('"', '');
  } catch (err) {
    if (isStatus(err, [412, 409]) || errorName(err) === 'PreconditionFailed') {
      throw new AlreadyExistsError();
    }
    throw err;
  }
}

/**
 * 無条件put（インデックス修復など、競合制御が不要な用途に限定して使う）。
 */
export async function putJson<T>(bucket: string, key: string, value: T): Promise<string> {
  const res = await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
    }),
  );
  return (res.ETag ?? '').replaceAll('"', '');
}
