import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from './s3Client.js';
import {
  getJson,
  getJsonOrThrow,
  putJsonIfMatch,
  putJsonIfAbsent,
} from './jsonStore.js';
import { ConflictError, NotFoundError, AlreadyExistsError } from './errors.js';

const s3mock = mockClient(s3);

/** transformToString を持つ擬似Bodyを作る。 */
function body(text: string) {
  return { transformToString: async () => text } as unknown as never;
}

beforeEach(() => {
  s3mock.reset();
});

describe('getJson', () => {
  it('存在すれば value と etag を返す', async () => {
    s3mock.on(GetObjectCommand).resolves({ Body: body('{"a":1}'), ETag: '"abc"' });
    const rec = await getJson<{ a: number }>('b', 'k');
    expect(rec).toEqual({ value: { a: 1 }, etag: 'abc' });
  });

  it('NoSuchKey は null', async () => {
    s3mock.on(GetObjectCommand).rejects(Object.assign(new Error('x'), { name: 'NoSuchKey' }));
    expect(await getJson('b', 'k')).toBeNull();
  });
});

describe('getJsonOrThrow', () => {
  it('存在しなければ NotFoundError', async () => {
    s3mock.on(GetObjectCommand).rejects(Object.assign(new Error('x'), { name: 'NoSuchKey' }));
    await expect(getJsonOrThrow('b', 'k')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('putJsonIfMatch', () => {
  it('成功すると新ETagを返す', async () => {
    s3mock.on(PutObjectCommand).resolves({ ETag: '"new"' });
    expect(await putJsonIfMatch('b', 'k', { a: 1 }, 'old')).toBe('new');
  });

  it('IfMatch を付与している', async () => {
    s3mock.on(PutObjectCommand).resolves({ ETag: '"new"' });
    await putJsonIfMatch('b', 'k', { a: 1 }, 'old');
    const call = s3mock.commandCalls(PutObjectCommand)[0]!;
    expect(call.args[0].input.IfMatch).toBe('"old"');
  });

  it('412 は ConflictError', async () => {
    s3mock
      .on(PutObjectCommand)
      .rejects(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 412 } }));
    await expect(putJsonIfMatch('b', 'k', {}, 'old')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('putJsonIfAbsent', () => {
  it('IfNoneMatch:* を付与する', async () => {
    s3mock.on(PutObjectCommand).resolves({ ETag: '"new"' });
    await putJsonIfAbsent('b', 'k', { a: 1 });
    const call = s3mock.commandCalls(PutObjectCommand)[0]!;
    expect(call.args[0].input.IfNoneMatch).toBe('*');
  });

  it('既存なら AlreadyExistsError', async () => {
    s3mock
      .on(PutObjectCommand)
      .rejects(Object.assign(new Error('x'), { name: 'PreconditionFailed' }));
    await expect(putJsonIfAbsent('b', 'k', {})).rejects.toBeInstanceOf(AlreadyExistsError);
  });
});
