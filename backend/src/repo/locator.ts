// locator index の作成・解決（repo層）。
// design.md「設計上の重要判断」に準拠。単独IDから正本パスへ O(1) で到達する。
//
// 原則:
//  - 正本を先に書き、locatorを後に書く。
//  - locator欠落は「正本不在」として扱い、呼び出し側で修復（再作成）できる。
//  - 作成は putJsonIfAbsent（二重作成防止）。

import type { OwnerType } from '@photo-album/shared';
import { metaKeys } from './keys.js';
import { getJson, putJsonIfAbsent, putJson } from './jsonStore.js';

export interface MediaLocator {
  albumId: string;
  ownerType: OwnerType;
  ownerId: string;
}

export interface AlbumLocator {
  ownerType: OwnerType;
  ownerId: string;
}

export interface CommentLocator {
  targetType: 'album' | 'media';
  targetId: string;
  rootCommentId: string;
}

// ---- media-locator ----

export async function createMediaLocator(
  metaBucket: string,
  mediaId: string,
  loc: MediaLocator,
): Promise<void> {
  await putJsonIfAbsent(metaBucket, metaKeys.mediaLocator(mediaId), loc);
}

export async function resolveMediaLocator(
  metaBucket: string,
  mediaId: string,
): Promise<MediaLocator | null> {
  const rec = await getJson<MediaLocator>(metaBucket, metaKeys.mediaLocator(mediaId));
  return rec?.value ?? null;
}

/** 修復（正本から再作成）。競合制御不要なので無条件put。 */
export async function repairMediaLocator(
  metaBucket: string,
  mediaId: string,
  loc: MediaLocator,
): Promise<void> {
  await putJson(metaBucket, metaKeys.mediaLocator(mediaId), loc);
}

// ---- album-locator ----

export async function createAlbumLocator(
  metaBucket: string,
  albumId: string,
  loc: AlbumLocator,
): Promise<void> {
  await putJsonIfAbsent(metaBucket, metaKeys.albumLocator(albumId), loc);
}

export async function resolveAlbumLocator(
  metaBucket: string,
  albumId: string,
): Promise<AlbumLocator | null> {
  const rec = await getJson<AlbumLocator>(metaBucket, metaKeys.albumLocator(albumId));
  return rec?.value ?? null;
}

// ---- comment-locator ----

export async function createCommentLocator(
  metaBucket: string,
  commentId: string,
  loc: CommentLocator,
): Promise<void> {
  await putJsonIfAbsent(metaBucket, metaKeys.commentLocator(commentId), loc);
}

export async function resolveCommentLocator(
  metaBucket: string,
  commentId: string,
): Promise<CommentLocator | null> {
  const rec = await getJson<CommentLocator>(metaBucket, metaKeys.commentLocator(commentId));
  return rec?.value ?? null;
}
