// アルバムのユースケース（app層）。requirements 要件3 に準拠。
//  - 作成: 所有主体の権限確認 → Album 作成 → album-locator 作成
//  - 一覧: 個人 + 所属グループのアルバムを集約（正本照合）。表紙プレビューURLと所有主体名を同梱。
//          グループ指定時はそのグループのアルバムだけ（グループの画面用。非メンバーは404）
//  - 詳細: 閲覧権限で判定（authorize）。所属（グループ名）を同梱
//  - 編集: 作成者のみ。表紙は同一アルバム・ready・写真に限定
//  - 表紙の自動設定/再選定: システム更新は内部で読み直し再試行

import {
  ALBUM_DESCRIPTION_MAX_LENGTH,
  ALBUM_TITLE_MAX_LENGTH,
  randomId,
  type Album,
  type AlbumDetail,
  type AlbumListItem,
  type Group,
  type Media,
  type OwnerType,
} from '@photo-album/shared';
import {
  getJson,
  getJsonOrThrow,
  putJsonIfAbsent,
  putJsonIfMatch,
  listJson,
  metaKeys,
  mediaKeys,
  getReadSignedUrl,
  ConflictError,
} from '../repo/index.js';
import { createAlbumLocator, resolveAlbumLocator } from '../repo/locator.js';
import { isValidManualCover, autoCoverOnReady, selectCover, type CoverCandidate } from '../domain/cover.js';
import { canCreateAlbum, isGroupMember } from '../domain/authz.js';
import { validateText } from '../domain/validation.js';
import type { AppContext } from './context.js';
import { AppError, notFoundOrForbidden } from './errors.js';
import { authorizeAlbumView, authorizeAlbumEdit } from './authorize.js';
import { getGroup } from './entities.js';
import { loadMemberGroups } from './groups.js';

const MAX_RETRY = 5;

function validateTitle(value: unknown): string {
  const v = validateText(typeof value === 'string' ? value.trim() : value, {
    label: 'タイトル',
    max: ALBUM_TITLE_MAX_LENGTH,
  });
  if (!v.ok) throw new AppError(422, 'invalid_title', v.message);
  return v.value;
}

function validateDescription(value: unknown): string {
  const v = validateText(value, {
    label: '説明',
    max: ALBUM_DESCRIPTION_MAX_LENGTH,
    allowEmpty: true,
    multiline: true,
  });
  if (!v.ok) throw new AppError(422, 'invalid_description', v.message);
  return v.value;
}

/** アルバムを作成する。 */
export async function createAlbum(
  ctx: AppContext,
  userId: string,
  params: { ownerType: OwnerType; ownerId: string; title: string; description?: string },
  now: string,
): Promise<Album> {
  if (params.ownerType !== 'user' && params.ownerType !== 'group') {
    throw new AppError(422, 'invalid_owner', '所有主体が不正です。');
  }
  if (typeof params.ownerId !== 'string' || params.ownerId.length === 0) {
    throw new AppError(422, 'invalid_owner', '所有主体が不正です。');
  }
  const title = validateTitle(params.title);
  const description = validateDescription(params.description ?? '');

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
    title,
    description,
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

export interface ListAlbumsOptions {
  /** 指定すると、そのグループのアルバムだけを返す（グループの画面用）。メンバーでなければ404。 */
  groupId?: string;
}

/**
 * ユーザーが閲覧できるアルバム一覧（個人＋所属グループ）。
 * 表紙のプレビューURL（ready のときのみ）と、グループ所有ならグループ名を同梱する。
 * 並び順: 個人 → グループ名順。各所有主体内は作成日時の新しい順（暫定）。
 * groupId を指定した場合は、そのグループのアルバムだけを返す（メンバーシップは正本で判定）。
 */
export async function listAlbums(
  ctx: AppContext,
  userId: string,
  opts: ListAlbumsOptions = {},
): Promise<AlbumListItem[]> {
  if (opts.groupId !== undefined) {
    const group = await getMemberGroup(ctx, opts.groupId, userId);
    return listGroupAlbums(ctx, group);
  }

  const personal = await listJson<Album>(ctx.metaBucket, metaKeys.albumsPrefix('user', userId));

  // 所属グループ（user-groups インデックス → 正本照合）
  const groups = (await loadMemberGroups(ctx, userId)).sort((a, b) =>
    a.name.localeCompare(b.name, 'ja'),
  );

  const out = await toListItems(ctx, personal, null);
  for (const g of groups) {
    out.push(...(await listGroupAlbums(ctx, g)));
  }
  return out;
}

/**
 * 要求者がメンバーであるグループの正本を返す。
 * 不正なID・存在しない・非メンバーはいずれも404（存在を推測させない, 要件2-10）。
 */
async function getMemberGroup(ctx: AppContext, groupId: unknown, userId: string): Promise<Group> {
  // キーの一部になるため、空文字・長すぎる値・スラッシュを含む値は存在しないものとして扱う
  if (
    typeof groupId !== 'string' ||
    groupId.length === 0 ||
    groupId.length > 128 ||
    groupId.includes('/')
  ) {
    throw notFoundOrForbidden();
  }
  const rec = await getGroup(ctx, groupId);
  if (!rec || !isGroupMember(rec.value, userId)) throw notFoundOrForbidden();
  return rec.value;
}

/** グループのアルバム一覧（正本のグループを受け取る。権限確認は呼び出し側で済ませる）。 */
async function listGroupAlbums(ctx: AppContext, group: Group): Promise<AlbumListItem[]> {
  const albums = await listJson<Album>(ctx.metaBucket, metaKeys.albumsPrefix('group', group.groupId));
  return toListItems(ctx, albums, group.name);
}

/** 一覧表示用に、作成日時の新しい順へ並べ、所有主体名と表紙のプレビューURLを付ける。 */
async function toListItems(
  ctx: AppContext,
  albums: Album[],
  ownerName: string | null,
): Promise<AlbumListItem[]> {
  const byNewest = (a: Album, b: Album) => (a.createdAt < b.createdAt ? 1 : -1);
  const out: AlbumListItem[] = [];
  for (const album of [...albums].sort(byNewest)) {
    out.push({ ...album, ownerName, coverPreviewUrl: await coverPreviewUrl(ctx, album) });
  }
  return out;
}

/** アルバムに所属（グループ名）を付ける。個人アルバムは null。 */
function toDetail(album: Album, group: Group | null): AlbumDetail {
  return { ...album, ownerName: album.ownerType === 'group' ? (group?.name ?? null) : null };
}

/** 表紙のプレビューURL。表紙メディアが同一アルバムの ready でなければ null（プレースホルダ）。 */
async function coverPreviewUrl(ctx: AppContext, album: Album): Promise<string | null> {
  if (!album.coverMediaId) return null;
  // キーは自アルバムの albumId で組み立てる（他アルバムのメディアを指していても参照できない）
  const rec = await getJson<Media>(ctx.metaBucket, metaKeys.media(album.albumId, album.coverMediaId));
  if (!rec || rec.value.status !== 'ready') return null;
  return getReadSignedUrl({
    bucket: ctx.mediaBucket,
    key: mediaKeys.preview(album.albumId, album.coverMediaId),
    kind: 'preview',
  });
}

/** アルバム詳細（閲覧権限で判定）。所属（グループ名）を同梱する。 */
export async function getAlbum(
  ctx: AppContext,
  albumId: string,
  userId: string,
): Promise<AlbumDetail> {
  const access = await authorizeAlbumView(ctx, albumId, userId);
  return toDetail(access.album.value, access.group);
}

export interface UpdateAlbumInput {
  title?: string;
  description?: string;
  /** 表紙変更。null で手動指定を解除し自動選定に戻す。 */
  coverMediaId?: string | null;
}

/** アルバム編集（作成者のみ）。表紙は同一アルバム・ready・写真に限定。所属（グループ名）を同梱して返す。 */
export async function updateAlbum(
  ctx: AppContext,
  albumId: string,
  userId: string,
  input: UpdateAlbumInput,
  now: string,
): Promise<AlbumDetail> {
  const access = await authorizeAlbumEdit(ctx, albumId, userId);
  const album = access.album.value;

  const next: Album = { ...album, updatedAt: now };
  if (input.title !== undefined) next.title = validateTitle(input.title);
  if (input.description !== undefined) next.description = validateDescription(input.description);

  if (input.coverMediaId !== undefined) {
    const candidates = await loadCoverCandidates(ctx, albumId);
    if (input.coverMediaId === null) {
      // 手動指定の解除: 自動選定に戻す
      next.coverSource = 'auto';
      next.coverMediaId = selectCover(candidates);
    } else {
      if (
        typeof input.coverMediaId !== 'string' ||
        !isValidManualCover(albumId, input.coverMediaId, candidates)
      ) {
        throw new AppError(422, 'invalid_cover', '表紙には同じアルバムの表示可能な写真のみ指定できます。');
      }
      next.coverMediaId = input.coverMediaId;
      next.coverSource = 'manual';
    }
  }

  // 利用者編集の競合（ETag不一致）は ConflictError → 409（http層で変換）
  await putJsonIfMatch(
    ctx.metaBucket,
    metaKeys.album(album.ownerType, album.ownerId, albumId),
    next,
    access.album.etag,
  );
  return toDetail(next, access.group);
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
 * - auto: 自動設定・再選定（写真を優先、無ければ動画、無ければ null）
 * - manual: 手動表紙が有効なら据え置き。無効化（削除）されたら自動選定に戻して再選定
 * ETag競合は内部で読み直して再試行し、利用者には 409 を返さない。
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
    let nextSource: Album['coverSource'] = album.coverSource;
    if (album.coverSource === 'manual') {
      const stillValid = candidates.some(
        (m) => m.mediaId === album.coverMediaId && m.status === 'ready',
      );
      if (stillValid) return; // 手動表紙は上書きしない
      nextSource = 'auto';
      nextCover = selectCover(candidates);
    } else {
      nextCover = autoCoverOnReady(album.coverSource, album.coverMediaId, candidates);
    }

    if (nextCover === undefined) return; // 変更不要
    if (nextCover === album.coverMediaId && nextSource === album.coverSource) return;

    const updated: Album = {
      ...album,
      coverMediaId: nextCover,
      coverSource: nextSource,
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

/** albumId だけから表紙を再計算する（album-locator で所有主体を解決）。locator 不在なら何もしない。 */
export async function recalcCoverForAlbum(ctx: AppContext, albumId: string): Promise<void> {
  const loc = await resolveAlbumLocator(ctx.metaBucket, albumId);
  if (!loc) return;
  await recalcCover(ctx, albumId, loc.ownerType, loc.ownerId);
}
