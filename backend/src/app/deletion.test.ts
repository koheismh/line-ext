import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { CopyObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { metaKeys, mediaKeys } from '../repo/keys.js';
import {
  startDelete,
  processDeletionJob,
  classifyForSweep,
  expireStaleMedia,
  deleteAlbum,
  reapMediaOfDeletedAlbum,
} from './deletion.js';
import { getAlbum, listAlbums } from './albums.js';
import { getMediaUrl } from './mediaQuery.js';
import { initSingleUpload } from './uploads.js';
import { listComments } from './comments.js';
import { AppError } from './errors.js';
import type { Album, Group, Media } from '@photo-album/shared';

let mem: MemoryS3;
const ctx = { metaBucket: 'meta', mediaBucket: 'media' };
const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

function seedAll(mediaStatus: Media['status'], createdBy = 'member') {
  const group: Group = {
    groupId: 'g1', name: 'f', adminUserIds: ['admin'], memberUserIds: ['admin', 'member'],
    createdBy: 'admin', ...base,
  };
  const album: Album = {
    albumId: 'a1', ownerType: 'group', ownerId: 'g1', title: 't', description: '',
    coverMediaId: null, coverSource: 'auto', createdBy: 'member', ...base,
  };
  const media: Media = {
    mediaId: 'm1', albumId: 'a1', kind: 'photo', status: mediaStatus, errorReason: null,
    originalExt: 'jpg', displayFileName: 'a.jpg', declaredByteSize: 10, declaredMimeType: 'image/jpeg',
    byteSize: 10, mimeType: 'image/jpeg', videoCodec: null, capturedAt: null, fileLastModified: null,
    uploadId: null, createdBy, ...base,
  };
  mem.put(metaKeys.group('g1'), group);
  mem.put(metaKeys.album('group', 'g1', 'a1'), album);
  mem.put(metaKeys.media('a1', 'm1'), media);
  mem.put(metaKeys.mediaLocator('m1'), { albumId: 'a1', ownerType: 'group', ownerId: 'g1' });
  mem.put(metaKeys.albumLocator('a1'), { ownerType: 'group', ownerId: 'g1' });
  // 原本・プレビューの実体を置く
  mem.store.set(mediaKeys.original('a1', 'm1', 'jpg'), { body: 'ORIGINAL', etag: 'o1' });
  mem.store.set(mediaKeys.preview('a1', 'm1'), { body: 'PREVIEW', etag: 'p1' });
}

beforeEach(() => {
  mem = installMemoryS3(s3);
});

describe('startDelete', () => {
  it('投稿者は削除開始でき deleting になり退避先が確定', async () => {
    seedAll('ready');
    const job = await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    expect(job).toEqual({ mediaId: 'm1', albumId: 'a1' });
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('deleting');
    expect(m.trash?.deletedDate).toBe('2026-05-01');
    expect(m.trash?.toKeys[0]).toContain('trash/2026-05-01/');
  });

  it('権限のないメンバーは404', async () => {
    seedAll('ready', 'member');
    await expect(startDelete(ctx, 'm1', 'stranger', new Date())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });

  it('既に deleting は冪等にジョブを返す', async () => {
    seedAll('deleting');
    const job = await startDelete(ctx, 'm1', 'admin', new Date());
    expect(job.mediaId).toBe('m1');
  });
});

describe('processDeletionJob', () => {
  it('コピー→検証→元削除→trashed。trash/ に存在し通常キーは消える', async () => {
    seedAll('ready');
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    await processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' });

    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('trashed');
    expect(m.trash?.movedAt).toBeTruthy();
    // 通常キーは消え、trash にある
    expect(mem.store.has(mediaKeys.original('a1', 'm1', 'jpg'))).toBe(false);
    expect(mem.store.has(mediaKeys.trashOriginal('2026-05-01', 'a1', 'm1', 'jpg'))).toBe(true);
  });

  it('二重実行でも冪等（trashedなら何もしない）', async () => {
    seedAll('ready');
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    await processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' });
    await processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' }); // 2回目
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('trashed');
  });
});

describe('classifyForSweep', () => {
  const now = Date.parse('2026-05-01T12:00:00Z');
  it('deleting が10分以上なら retry_delete', () => {
    expect(classifyForSweep({ status: 'deleting', updatedAt: '2026-05-01T11:00:00Z' }, now)).toBe('retry_delete');
    expect(classifyForSweep({ status: 'deleting', updatedAt: '2026-05-01T11:59:00Z' }, now)).toBe('none');
  });
  it('uploading/validating が24時間以上なら expire', () => {
    expect(classifyForSweep({ status: 'uploading', updatedAt: '2026-04-30T11:00:00Z' }, now)).toBe('expire');
    expect(classifyForSweep({ status: 'validating', updatedAt: '2026-05-01T11:00:00Z' }, now)).toBe('none');
  });
  it('ready は none', () => {
    expect(classifyForSweep({ status: 'ready', updatedAt: '2020-01-01T00:00:00Z' }, now)).toBe('none');
  });
});

describe('expireStaleMedia', () => {
  it('uploading を expired にし、残った原本・プレビューは直接消さずごみ箱へ退避する（要件7-11）', async () => {
    seedAll('uploading');
    await expireStaleMedia(ctx, 'a1', 'm1', new Date('2026-05-02T00:00:00Z'));
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('expired');
    expect(m.trash?.deletedDate).toBe('2026-05-02');
    expect(m.trash?.movedAt).toBeTruthy();
    expect(mem.store.has(mediaKeys.original('a1', 'm1', 'jpg'))).toBe(false);
    expect(mem.store.has(mediaKeys.trashOriginal('2026-05-02', 'a1', 'm1', 'jpg'))).toBe(true);
  });

  it('ready など失効対象外の状態は変更しない', async () => {
    seedAll('ready');
    await expireStaleMedia(ctx, 'a1', 'm1');
    expect((mem.get(metaKeys.media('a1', 'm1')) as Media).status).toBe('ready');
    expect(mem.store.has(mediaKeys.original('a1', 'm1', 'jpg'))).toBe(true);
  });
});

// ---- アルバム削除（要件3-15〜3-17）----

const NOW = new Date('2026-05-01T00:00:00Z');

/** アルバム a1 にメディアを追加する（seedAll の後に呼ぶ）。原本・プレビューの実体も置く。 */
function addMedia(mediaId: string, mediaStatus: Media['status'], createdBy = 'member') {
  const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
  mem.put(metaKeys.media('a1', mediaId), { ...m, mediaId, status: mediaStatus, createdBy });
  mem.put(metaKeys.mediaLocator(mediaId), { albumId: 'a1', ownerType: 'group', ownerId: 'g1' });
  mem.store.set(mediaKeys.original('a1', mediaId, 'jpg'), { body: 'ORIGINAL', etag: `o-${mediaId}` });
  mem.store.set(mediaKeys.preview('a1', mediaId), { body: 'PREVIEW', etag: `p-${mediaId}` });
}

const statusOf = (mediaId: string) => (mem.get(metaKeys.media('a1', mediaId)) as Media).status;
const jobIds = (jobs: { mediaId: string }[]) => jobs.map((j) => j.mediaId).sort();
const status = (e: unknown) => (e instanceof AppError ? e.status : undefined);

/** key の n 回目の読み込みの直後に、別の処理が正本を更新した状況を再現する（ETag 競合の再試行の確認用）。 */
function interfereAfterRead(key: string, nth: number, interfere: () => void) {
  let count = 0;
  mem.mock.on(GetObjectCommand).callsFake((input) => {
    const rec = mem.store.get(input.Key as string);
    if (!rec) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    const res = { Body: { transformToString: async () => rec.body }, ETag: `"${rec.etag}"` };
    if (input.Key === key && ++count === nth) interfere();
    return res;
  });
}

describe('deleteAlbum', () => {
  beforeAll(() => {
    process.env.AWS_ACCESS_KEY_ID ??= 'test';
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
    process.env.AWS_REGION ??= 'ap-northeast-1';
  });

  it('作成者が削除すると全員から見えなくなり、ready/error/deleting のメディアが削除ジョブになる', async () => {
    seedAll('ready');
    addMedia('m2', 'error');
    addMedia('m3', 'uploading');
    addMedia('m4', 'trashed');
    addMedia('m5', 'deleting');

    const jobs = await deleteAlbum(ctx, 'a1', 'member', NOW);

    expect(jobIds(jobs)).toEqual(['m1', 'm2', 'm5']);
    expect(['m1', 'm2', 'm5'].map(statusOf)).toEqual(['deleting', 'deleting', 'deleting']);
    expect(statusOf('m3')).toBe('uploading'); // 途中の処理は壊さない（24時間後の失効で片付く）
    expect(statusOf('m4')).toBe('trashed');
    const m1 = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m1.trash?.deletedDate).toBe('2026-05-01');
    const album = mem.get(metaKeys.album('group', 'g1', 'a1')) as Album;
    expect(album.deletedAt).toBe(NOW.toISOString());
    expect(album.deletedBy).toBe('member');
    // 作成者にも管理者にも、一覧にも詳細にも出ない
    for (const user of ['member', 'admin']) {
      await expect(getAlbum(ctx, 'a1', user)).rejects.toSatisfy((e) => status(e) === 404);
    }
    mem.put(metaKeys.userGroup('member', 'g1'), { groupId: 'g1' });
    expect(await listAlbums(ctx, 'member')).toEqual([]);
    expect(await listAlbums(ctx, 'member', { groupId: 'g1' })).toEqual([]);
  });

  it('削除ワーカーが続けて、メディアはごみ箱へ移り、通常のキーは消える（コピー検証の不変条件はそのまま）', async () => {
    seedAll('ready');
    addMedia('m2', 'error');
    const jobs = await deleteAlbum(ctx, 'a1', 'member', NOW);
    for (const job of jobs) await processDeletionJob(ctx, job);

    expect(['m1', 'm2'].map(statusOf)).toEqual(['trashed', 'trashed']);
    expect(mem.store.has(mediaKeys.original('a1', 'm2', 'jpg'))).toBe(false);
    expect(mem.store.has(mediaKeys.trashOriginal('2026-05-01', 'a1', 'm2', 'jpg'))).toBe(true);
    expect(mem.store.has(mediaKeys.trashPreview('2026-05-01', 'a1', 'm1'))).toBe(true);
  });

  it('グループ管理者も削除できる。作成者でも管理者でもないメンバーは403、非メンバーは404（何も変わらない）', async () => {
    seedAll('ready');
    const group = mem.get(metaKeys.group('g1')) as Group;
    mem.put(metaKeys.group('g1'), { ...group, memberUserIds: [...group.memberUserIds, 'other'] });

    await expect(deleteAlbum(ctx, 'a1', 'other', NOW)).rejects.toSatisfy((e) => status(e) === 403);
    await expect(deleteAlbum(ctx, 'a1', 'stranger', NOW)).rejects.toSatisfy((e) => status(e) === 404);
    await expect(deleteAlbum(ctx, 'no-such-album', 'admin', NOW)).rejects.toSatisfy((e) => status(e) === 404);
    expect((mem.get(metaKeys.album('group', 'g1', 'a1')) as Album).deletedAt).toBeUndefined();
    expect(statusOf('m1')).toBe('ready');

    const jobs = await deleteAlbum(ctx, 'a1', 'admin', NOW);
    expect(jobIds(jobs)).toEqual(['m1']);
  });

  it('個人アルバムは所有者だけが削除でき、他人には存在を隠す（404）', async () => {
    const album: Album = {
      albumId: 'pa', ownerType: 'user', ownerId: 'owner', title: 't', description: '',
      coverMediaId: null, coverSource: 'auto', createdBy: 'owner', ...base,
    };
    mem.put(metaKeys.album('user', 'owner', 'pa'), album);
    mem.put(metaKeys.albumLocator('pa'), { ownerType: 'user', ownerId: 'owner' });

    await expect(deleteAlbum(ctx, 'pa', 'other', NOW)).rejects.toSatisfy((e) => status(e) === 404);
    await expect(deleteAlbum(ctx, 'pa', 'owner', NOW)).resolves.toEqual([]);
    expect((mem.get(metaKeys.album('user', 'owner', 'pa')) as Album).deletedAt).toBeTruthy();
  });

  it('削除後は、写真・動画のURL発行、アップロード開始、コメントの閲覧もできない（メディアが ready のままでも）', async () => {
    seedAll('ready');
    await deleteAlbum(ctx, 'a1', 'member', NOW);
    // 削除ワーカーがまだ動いていない（ready に戻した）状態でも、アルバム経由で止まる
    mem.put(metaKeys.media('a1', 'm1'), { ...(mem.get(metaKeys.media('a1', 'm1')) as Media), status: 'ready' });

    await expect(getMediaUrl(ctx, 'm1', 'member', 'original')).rejects.toSatisfy((e) => status(e) === 404);
    await expect(getMediaUrl(ctx, 'm1', 'admin', 'preview')).rejects.toSatisfy((e) => status(e) === 404);
    await expect(
      initSingleUpload(ctx, {
        albumId: 'a1', userId: 'member', declaredMimeType: 'image/jpeg', declaredByteSize: 10,
        displayFileName: 'x.jpg', now: NOW.toISOString(),
      }),
    ).rejects.toSatisfy((e) => status(e) === 404);
    await expect(listComments(ctx, 'album', 'a1', 'member')).rejects.toSatisfy((e) => status(e) === 404);
  });

  it('二重実行は冪等: 削除した本人には成功（残りの処理も続ける）、ほかの人には404。印の時刻は変わらない', async () => {
    seedAll('ready');
    await deleteAlbum(ctx, 'a1', 'member', NOW);
    addMedia('m2', 'ready'); // 1回目のあとに（削除と同時に処理が終わって）ready になったメディア

    const again = await deleteAlbum(ctx, 'a1', 'member', new Date('2026-05-02T00:00:00Z'));
    expect(jobIds(again)).toEqual(['m1', 'm2']); // 取りこぼしを拾い、deleting のものも再投入できる
    expect(statusOf('m2')).toBe('deleting');
    expect((mem.get(metaKeys.album('group', 'g1', 'a1')) as Album).deletedAt).toBe(NOW.toISOString());
    await expect(deleteAlbum(ctx, 'a1', 'admin', NOW)).rejects.toSatisfy((e) => status(e) === 404);
  });

  it('表紙の自動設定など別の更新と競合しても、読み直して削除する（他の更新を消さない）', async () => {
    seedAll('ready');
    const key = metaKeys.album('group', 'g1', 'a1');
    // deleteAlbum の1回目の読み込み → authorize の読み込み（2回目）の直後に別の更新が入る
    interfereAfterRead(key, 2, () =>
      mem.put(key, { ...(mem.get(key) as Album), coverMediaId: 'm1', title: '更新後' }),
    );
    await deleteAlbum(ctx, 'a1', 'member', NOW);
    const stored = mem.get(key) as Album;
    expect(stored.deletedAt).toBe(NOW.toISOString());
    expect(stored.title).toBe('更新後');
  });
});

describe('reapMediaOfDeletedAlbum（定期掃除による回収）', () => {
  it('削除済みアルバムに残った ready/error のメディアは削除を始める。uploading は触らない', async () => {
    seedAll('ready');
    addMedia('m2', 'error');
    addMedia('m3', 'uploading');
    const key = metaKeys.album('group', 'g1', 'a1');
    mem.put(key, { ...(mem.get(key) as Album), deletedAt: NOW.toISOString(), deletedBy: 'member' });
    const cache = new Map<string, boolean>();

    const results = await Promise.all(
      ['m1', 'm2', 'm3'].map((id) =>
        reapMediaOfDeletedAlbum(ctx, mem.get(metaKeys.media('a1', id)) as Media, NOW, cache),
      ),
    );
    expect(results.map((r) => r?.mediaId ?? null)).toEqual(['m1', 'm2', null]);
    expect([statusOf('m1'), statusOf('m2'), statusOf('m3')]).toEqual(['deleting', 'deleting', 'uploading']);
    expect(cache.get('a1')).toBe(true);
  });

  it('削除されていないアルバムのメディアには何もしない', async () => {
    seedAll('ready');
    const cache = new Map<string, boolean>();
    const job = await reapMediaOfDeletedAlbum(ctx, mem.get(metaKeys.media('a1', 'm1')) as Media, NOW, cache);
    expect(job).toBeNull();
    expect(statusOf('m1')).toBe('ready');
    expect(cache.get('a1')).toBe(false);
  });

  it('二重実行しても冪等（deleting のメディアは何度でも再投入でき、trashed は null）', async () => {
    seedAll('ready');
    const key = metaKeys.album('group', 'g1', 'a1');
    mem.put(key, { ...(mem.get(key) as Album), deletedAt: NOW.toISOString(), deletedBy: 'member' });
    const cache = new Map<string, boolean>();
    const media = mem.get(metaKeys.media('a1', 'm1')) as Media;
    await reapMediaOfDeletedAlbum(ctx, media, NOW, cache);
    // 状態が deleting になった後に、同じメディア（古い状態のまま）でもう一度呼ばれても壊れない
    await expect(reapMediaOfDeletedAlbum(ctx, media, NOW, cache)).resolves.toEqual({ mediaId: 'm1', albumId: 'a1' });
    expect(statusOf('m1')).toBe('deleting');
    await processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' });
    await expect(reapMediaOfDeletedAlbum(ctx, media, NOW, cache)).resolves.toBeNull();
    expect(statusOf('m1')).toBe('trashed');
  });
});

describe('ごみ箱の不変条件', () => {
  it('コピー先の検証に失敗したら元を消さず、trashed にもしない（再試行に委ねる）', async () => {
    seedAll('ready');
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    // コピーが実際には行われない障害を再現
    mem.mock.on(CopyObjectCommand).callsFake(() => ({}));
    await expect(processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' })).rejects.toThrow();
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('deleting');
    expect(mem.store.has(mediaKeys.original('a1', 'm1', 'jpg'))).toBe(true);
    expect(mem.store.has(mediaKeys.preview('a1', 'm1'))).toBe(true);
  });

  it('途中で止まっても再実行で続きから完了する（元が既に無いものはスキップ）', async () => {
    seedAll('ready');
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    // 前回の実行で原本だけ移動済みの状態
    mem.store.set(mediaKeys.trashOriginal('2026-05-01', 'a1', 'm1', 'jpg'), { body: 'ORIGINAL', etag: 'x' });
    mem.store.delete(mediaKeys.original('a1', 'm1', 'jpg'));
    await processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' });
    expect((mem.get(metaKeys.media('a1', 'm1')) as Media).status).toBe('trashed');
    expect(mem.store.has(mediaKeys.preview('a1', 'm1'))).toBe(false);
    expect(mem.store.has(mediaKeys.trashPreview('2026-05-01', 'a1', 'm1'))).toBe(true);
  });

  it('error 状態のメディアも投稿者が削除できる（要件7-10）', async () => {
    seedAll('error');
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    expect((mem.get(metaKeys.media('a1', 'm1')) as Media).status).toBe('deleting');
  });

  it('表紙のメディアを削除すると表紙を再選定する（要件3-10）', async () => {
    seedAll('ready');
    const albumKey = metaKeys.album('group', 'g1', 'a1');
    mem.put(albumKey, { ...(mem.get(albumKey) as Album), coverMediaId: 'm1' });
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    expect((mem.get(albumKey) as Album).coverMediaId).toBeNull();
  });

  it('他のメンバーが投稿したメディアは削除不可(403)、管理者は削除可', async () => {
    seedAll('ready', 'member');
    const group = mem.get(metaKeys.group('g1')) as Group;
    mem.put(metaKeys.group('g1'), { ...group, memberUserIds: [...group.memberUserIds, 'other'] });
    await expect(startDelete(ctx, 'm1', 'other', new Date())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 403,
    );
    await expect(startDelete(ctx, 'm1', 'admin', new Date())).resolves.toEqual({ mediaId: 'm1', albumId: 'a1' });
  });
});
