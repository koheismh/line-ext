import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from './s3Client.js';
import {
  createMediaLocator,
  resolveMediaLocator,
  repairMediaLocator,
  resolveAlbumLocator,
} from './locator.js';

const s3mock = mockClient(s3);

function body(text: string) {
  return { transformToString: async () => text } as unknown as never;
}

beforeEach(() => s3mock.reset());

describe('media-locator', () => {
  it('作成は IfNoneMatch:* を使う', async () => {
    s3mock.on(PutObjectCommand).resolves({ ETag: '"e"' });
    await createMediaLocator('meta', 'm1', { albumId: 'a1', ownerType: 'group', ownerId: 'g1' });
    const call = s3mock.commandCalls(PutObjectCommand)[0]!;
    expect(call.args[0].input.IfNoneMatch).toBe('*');
    expect(call.args[0].input.Key).toBe('media-locator/m1.json');
  });

  it('解決できれば中身を返す', async () => {
    s3mock
      .on(GetObjectCommand)
      .resolves({ Body: body('{"albumId":"a1","ownerType":"group","ownerId":"g1"}'), ETag: '"e"' });
    expect(await resolveMediaLocator('meta', 'm1')).toEqual({
      albumId: 'a1',
      ownerType: 'group',
      ownerId: 'g1',
    });
  });

  it('欠落（正本不在）は null', async () => {
    s3mock.on(GetObjectCommand).rejects(Object.assign(new Error('x'), { name: 'NoSuchKey' }));
    expect(await resolveMediaLocator('meta', 'm1')).toBeNull();
  });

  it('修復は無条件put（IfNoneMatchなし）', async () => {
    s3mock.on(PutObjectCommand).resolves({ ETag: '"e"' });
    await repairMediaLocator('meta', 'm1', { albumId: 'a1', ownerType: 'user', ownerId: 'u1' });
    const call = s3mock.commandCalls(PutObjectCommand)[0]!;
    expect(call.args[0].input.IfNoneMatch).toBeUndefined();
  });
});

describe('album-locator', () => {
  it('解決できれば所有主体を返す', async () => {
    s3mock
      .on(GetObjectCommand)
      .resolves({ Body: body('{"ownerType":"user","ownerId":"u1"}'), ETag: '"e"' });
    expect(await resolveAlbumLocator('meta', 'a1')).toEqual({ ownerType: 'user', ownerId: 'u1' });
  });
});
