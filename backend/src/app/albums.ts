// アルバムのユースケース（app層）。requirements 要件3 に準拠。
//  - 作成: 所有主体の権限確認 → Album 作成 → album-locator 作成
//  - 一覧: 個人 + 所属グループのアルバムを集約（正本照合）
//  - 詳細: 閲覧権限で判定（authorize）
//  - 編集: 作成者のみ。表紙は同一アルバム・ready・写真に限定
//  - 表紙の自動設定/再選定: システム更新は内部で読み直し再試行

import {
  randomId,
  type Album,
  type Group,
  type Media,
  type OwnerType,
} from '@photo-album/shared';
import {
  getJsonOrThrow,
  putJsonIfAbsent,
  putJsonIfMatch,
  listJson,
  metaKeys,
  ConflictError,
} from '../repo/index.js';
import { createAlbumLocator } from '../repo/locator.js';
import { isValidManualCover, autoCoverOnReady, selectCover, type CoverCandidate } from '../domain/cover.js';
import { canCreateAlbum } from '../domain/authz.js';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { authorizeAlbumView, authorizeAlbumEdit } from './authorize.js';
import { getGroup } from './entities.js';

const MAX_RETRY = 5;

/** アルバムを作成する。 */
export async function createAlbum(
  ctx: AppContext,
  userId: string,
  params: { ownerType: OwnerType; ownerId: string; title: string; description?: string },
  now: string,
): Promise<Album> {
  let group: Group | null = null;
  if (params.ownerType === 'group') {
    const rec = await getGroup(ctx, params.ownerId);
    group = rec?.value ?? null;
  }
  if (!canCreateAlbum(params.ownerType, params.ownerId, userId, group)) {
    throw new AppError(403, 'forbidden', 'このアルバムを作成する権限がありません。');
  }
  const album: Album = {
    albumId: randomId(),
    ownerType: params.ownerType,
    ownerId: params.ownerId,
    title: params.title,
    description: params.description ?? '',
    coverMediaId: null,
    coverSource: 'auto',
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  await putJsonIfAbsent(
    ctx.metaBucket,
    metaKeys.album(album.ownerType, album.ownerId, album.albumId),
    album,
  );
  await createAlbumLocator(ctx.metaBucket, album.albumId, {
    ownerType: album.ownerType,
    ownerId: album.ownerId,
  });
  return album;
}

/** ユーザーが閲覧できるアルバム一覧（個人＋所属グループ）。 */
export async function listAlbums(ctx: AppContext, userId: string): Promise<Album[]> {
  // 個人アルバム
  const personal = await listJson<Album>(
    ctx.metaBucket,
    `albums/user/${userId}/`,
  );

  // 所属グループ（user-groups インデックス → 正本照合）
  const userGroups = await listJson<{ groupId: string }>(
    ctx.metaBucket,
    metaKeys.userGroupsPrefix(userId),
  );
  const groupAlbums: Album[] = [];
  for (const ug of userGroups) {
    const groupRec = await getGroup(ctx, ug.groupId);
    // 正本で実際にメンバーか照合（インデックスを信用しない）
    if (!groupRec || !groupRec.value.memberUserIds.includes(userId)) continue;
    const albums = await listJson<Album>(ctx.metaBucket, `albums/group/${ug.groupId}/`);
    groupAlbums.push(...albums);
  }
  return [...personal, ...groupAlbums];
}

/** アルバム詳細（閲覧権限で判定）。 */
export async function getAlbum(ctx: AppContext, albumId: string, userId: string): Promise<Album> {
  const access = await authorizeAlbumView(ctx, albumId, userId);
  return access.album.value;
}

export interface UpdateAlbumInput {
  title?: string;
  description?: string;
  /** 表紙変更。null で解除。 */
  coverMediaId?: string | null;
}

/** アルバム編集（作成者のみ）。表紙は同一アルバム・ready・写真に限定。 */
export async function updateAlbum(
  ctx: AppContext,
  albumId: string,
  userId: string,
  input: UpdateAlbumInput,
  now: string,
): Promise<Album> {
  const access = await authorizeAlbumEdit(ctx, albumId, userId);
  const album = access.album.value;

  const next: Album = { ...album, updatedAt: now };
  if (input.title !== undefined) next.title = input.title;
  if (input.description !== undefined) next.description = input.description;

  if (input.coverMediaId !== undefined) {
    if (input.coverMediaId === null) {
      next.coverMediaId = null;
      next.coverSource = 'manual';
    } else {
      const candidates = await loadCoverCandidates(ctx, albumId);
      if (!isValidManualCover(albumId, input.coverMediaId, candidates)) {
        throw new AppError(422, 'invalid_cover', '表紙には同じアルバムの表示可能な写真のみ指定できます。');
      }
      next.coverMediaId = input.coverMediaId;
      next.coverSource = 'manual';
    }
  }

  await putJsonIfMatch(
    ctx.metaBucket,
    metaKeys.album(album.ownerType, album.ownerId, albumId),
    next,
    access.album.etag,
  );
  return next;
}

/** アルバム配下メディアを表紙候補として読み込む。 */
async function loadCoverCandidates(ctx: AppContext, albumId: string): Promise<CoverCandidate[]> {
  const medias = await listJson<Media>(ctx.metaBucket, metaKeys.mediaPrefix(albumId));
  return medias.map((m) => ({
    mediaId: m.mediaId,
    albumId: m.albumId,
    kind: m.kind,
    status: m.status,
    createdAt: m.createdAt,
  }));
}

/**
 * メディアが ready になった/削除された際に表紙を再計算する（システム更新）。
 * coverSource=auto のときのみ自動設定・再選定。ETag競合は内部で読み直して再試行し、
 * 利用者には 409 を返さない。
 */
export async function recalcCover(
  ctx: AppContext,
  albumId: string,
  ownerType: OwnerType,
  ownerId: string,
): Promise<void> {
  const candidates = await loadCoverCandidates(ctx, albumId);
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const rec = await getJsonOrThrow<Album>(
      ctx.metaBucket,
      metaKeys.album(ownerType, ownerId, albumId),
    );
    const album = rec.value;

    let nextCover: string | null | undefined;
    if (album.coverSource === 'manual') {
      // 手動表紙が無効化（削除）されていれば再選定、そうでなければ据え置き
      const stillValid = candidates.some(
        (m) => m.mediaId === album.coverMediaId && m.status === 'ready',
      );
      nextCover = stillValid ? undefined : selectCover(candidates);
    } else {
      nextCover = autoCoverOnReady(album.coverSource, album.coverMediaId, candidates);
    }

    if (nextCover === undefined || nextCover === album.coverMediaId) {
      return; // 変更不要
    }

    const updated: Album = {
      ...album,
      coverMediaId: nextCover,
      updatedAt: new Date().toISOString(),
    };
    try {
      await putJsonIfMatch(
        ctx.metaBucket,
        metaKeys.album(ownerType, ownerId, albumId),
        updated,
        rec.etag,
      );
      return;
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_RETRY - 1) continue;
      throw err;
    }
  }
}
