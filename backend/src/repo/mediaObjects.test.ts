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
  getReadSignedUrl,
  clearSignedUrlCache,
} from './mediaObjects.js';

const s3mock = mockClient(s3);

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
      Parts: [{ Size: 100 }, { Size: 200 }],
      IsTruncated: false,
    });
    expect(await sumUploadedParts('b', 'k', 'up')).toBe(300);
  });
  it('ページングを辿る', async () => {
    s3mock
      .on(ListPartsCommand)
      .resolvesOnce({ Parts: [{ Size: 100 }], IsTruncated: true, NextPartNumberMarker: '1' })
      .resolvesOnce({ Parts: [{ Size: 50 }], IsTruncated: false });
    expect(await sumUploadedParts('b', 'k', 'up')).toBe(150);
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
