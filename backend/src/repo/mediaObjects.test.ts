import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';
import { s3 } from './s3Client.js';
import {
  headObjectSize,
  verifyCopiedBySize,
  copyObject,
  deleteObject,
  sumUploadedParts,
  listUploadedParts,
  getReadSignedUrl,
  getUploadSignedUrl,
  clearSignedUrlCache,
  contentDispositionAttachment,
} from './mediaObjects.js';

const s3mock = mockClient(s3);

// 署名付きURL生成にはダミー資格情報が必要
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';

beforeEach(() => {
  s3mock.reset();
  clearSignedUrlCache();
});

describe('headObjectSize', () => {
  it('サイズを返す', async () => {
    s3mock.on(HeadObjectCommand).resolves({ ContentLength: 123 });
    expect(await headObjectSize('b', 'k')).toBe(123);
  });
  it('404はnull', async () => {
    s3mock.on(HeadObjectCommand).rejects(Object.assign(new Error('x'), { name: 'NotFound' }));
    expect(await headObjectSize('b', 'k')).toBeNull();
  });
});

describe('verifyCopiedBySize', () => {
  it('サイズ一致でtrue', async () => {
    s3mock.on(HeadObjectCommand).resolves({ ContentLength: 100 });
    expect(await verifyCopiedBySize('b', 'from', 'to')).toBe(true);
  });
  it('コピー先が無ければfalse', async () => {
    s3mock
      .on(HeadObjectCommand, { Bucket: 'b', Key: 'from' })
      .resolves({ ContentLength: 100 });
    s3mock
      .on(HeadObjectCommand, { Bucket: 'b', Key: 'to' })
      .rejects(Object.assign(new Error('x'), { name: 'NotFound' }));
    expect(await verifyCopiedBySize('b', 'from', 'to')).toBe(false);
  });
});

describe('copyObject / deleteObject', () => {
  it('CopyObject を正しい CopySource で呼ぶ', async () => {
    s3mock.on(CopyObjectCommand).resolves({});
    await copyObject('b', 'from/key', 'to/key');
    const call = s3mock.commandCalls(CopyObjectCommand)[0]!;
    expect(call.args[0].input.CopySource).toBe('b/from%2Fkey');
    expect(call.args[0].input.Key).toBe('to/key');
  });
  it('deleteObject を呼ぶ', async () => {
    s3mock.on(DeleteObjectCommand).resolves({});
    await deleteObject('b', 'k');
    expect(s3mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });
});

describe('sumUploadedParts', () => {
  it('全パートのサイズを合計する', async () => {
    s3mock.on(ListPartsCommand).resolves({
      Parts: [
        { PartNumber: 1, ETag: '"a"', Size: 100 },
        { PartNumber: 2, ETag: '"b"', Size: 200 },
      ],
      IsTruncated: false,
    });
    expect(await sumUploadedParts('b', 'k', 'up')).toBe(300);
  });
  it('ページングを辿る', async () => {
    s3mock
      .on(ListPartsCommand)
      .resolvesOnce({
        Parts: [{ PartNumber: 1, ETag: '"a"', Size: 100 }],
        IsTruncated: true,
        NextPartNumberMarker: '1',
      })
      .resolvesOnce({ Parts: [{ PartNumber: 2, ETag: '"b"', Size: 50 }], IsTruncated: false });
    expect(await sumUploadedParts('b', 'k', 'up')).toBe(150);
  });
});

describe('listUploadedParts', () => {
  it('パート番号順に ETag とサイズを返す（ページング対応）', async () => {
    s3mock
      .on(ListPartsCommand)
      .resolvesOnce({
        Parts: [{ PartNumber: 2, ETag: '"b"', Size: 5 }],
        IsTruncated: true,
        NextPartNumberMarker: '2',
      })
      .resolvesOnce({ Parts: [{ PartNumber: 1, ETag: '"a"', Size: 7 }], IsTruncated: false });
    expect(await listUploadedParts('b', 'k', 'up')).toEqual([
      { partNumber: 1, etag: '"a"', size: 7 },
      { partNumber: 2, etag: '"b"', size: 5 },
    ]);
  });
});

describe('getUploadSignedUrl', () => {
  it('Content-Type と Content-Length を署名し、チェックサムのクエリを含めない', async () => {
    const url = new URL(
      await getUploadSignedUrl({
        bucket: 'b',
        key: 'originals/a/m/source.jpg',
        contentType: 'image/jpeg',
        contentLength: 1234,
        expiresIn: 900,
      }),
    );
    const signed = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signed.split(';')).toEqual(expect.arrayContaining(['content-type', 'content-length', 'host']));
    expect([...url.searchParams.keys()].filter((k) => k.toLowerCase().includes('checksum'))).toEqual([]);
  });
});

describe('contentDispositionAttachment', () => {
  it('日本語ファイル名を RFC 5987 形式でエンコードする', () => {
    expect(contentDispositionAttachment('旅行 (1).jpg')).toBe(
      "attachment; filename*=UTF-8''%E6%97%85%E8%A1%8C%20%281%29.jpg",
    );
    expect(contentDispositionAttachment()).toBe('attachment');
  });
});

describe('getReadSignedUrl（キャッシュ）', () => {
  it('同一(key,kind)は2回目も同じURL（再利用）', async () => {
    const u1 = await getReadSignedUrl({ bucket: 'b', key: 'previews/x.jpg', kind: 'preview' });
    const u2 = await getReadSignedUrl({ bucket: 'b', key: 'previews/x.jpg', kind: 'preview' });
    expect(u1).toBe(u2);
  });
  it('kindが異なればURLも異なる', async () => {
    const preview = await getReadSignedUrl({ bucket: 'b', key: 'k', kind: 'preview' });
    const original = await getReadSignedUrl({ bucket: 'b', key: 'k', kind: 'original' });
    expect(preview).not.toBe(original);
  });
});
