// コメントのユースケース（app層）。requirements 要件6 に準拠。
//  - listComments: 対象の閲覧認可 → スレッド整形（墓標・子全滅の表示ルール）
//  - postComment: 閲覧認可 → 2階層固定 → 保存＋comment-locator（保存は生値、XSSは表示時エスケープ）
//  - deleteComment: 投稿者/管理者のみ → 親=墓標・子=非表示（非破壊）
//  - 対象メディアが deleting 以降なら一覧非表示・新規投稿拒否

import {
  ulid,
  type Comment,
  type CommentTargetType,
  type Media,
} from '@photo-album/shared';
import {
  getJson,
  putJsonIfMatch,
  putJsonIfAbsent,
  listJson,
  metaKeys,
} from '../repo/index.js';
import {
  createCommentLocator,
  resolveCommentLocator,
} from '../repo/locator.js';
import { buildThreads, resolveRootCommentId, markDeleted, type ThreadView } from '../domain/comment.js';
import { canDeleteComment } from '../domain/authz.js';
import type { AppContext } from './context.js';
import { AppError, notFoundOrForbidden, forbidden } from './errors.js';
import { authorizeAlbumView, authorizeMediaView, type AlbumAccess } from './authorize.js';

const BODY_MAX_LENGTH = 2000;

/** 対象(album/media)の閲覧認可と、メディア対象時の可視状態チェック。 */
async function authorizeTarget(
  ctx: AppContext,
  targetType: CommentTargetType,
  targetId: string,
  userId: string,
): Promise<AlbumAccess> {
  if (targetType === 'album') {
    return authorizeAlbumView(ctx, targetId, userId);
  }
  // media: 親アルバムの閲覧権限で判定しつつ、deleting以降は対象外
  const mediaAccess = await authorizeMediaView(ctx, targetId, userId);
  if (isMediaHidden(mediaAccess.media.value)) {
    throw notFoundOrForbidden('対象が見つかりません。');
  }
  return authorizeAlbumView(ctx, mediaAccess.album.albumId, userId);
}

/** メディアが一般画面で非表示（deleting以降）か。 */
function isMediaHidden(media: Media): boolean {
  return (
    media.status === 'deleting' ||
    media.status === 'trashed' ||
    media.status === 'expired'
  );
}

/** コメント一覧（スレッド整形）。 */
export async function listComments(
  ctx: AppContext,
  targetType: CommentTargetType,
  targetId: string,
  userId: string,
): Promise<ThreadView[]> {
  await authorizeTarget(ctx, targetType, targetId, userId);
  const comments = await listJson<Comment>(
    ctx.metaBucket,
    metaKeys.commentTargetPrefix(targetType, targetId),
  );
  return buildThreads(comments);
}

export interface PostCommentInput {
  targetType: CommentTargetType;
  targetId: string;
  body: string;
  /** 返信先コメントID（任意）。 */
  replyToCommentId?: string | null;
}

/** コメントを投稿する。 */
export async function postComment(
  ctx: AppContext,
  userId: string,
  input: PostCommentInput,
  now: string,
): Promise<Comment> {
  await authorizeTarget(ctx, input.targetType, input.targetId, userId);

  const body = input.body;
  if (body.length === 0 || body.length > BODY_MAX_LENGTH) {
    throw new AppError(422, 'invalid_comment', `コメントは1〜${BODY_MAX_LENGTH}文字で入力してください。`);
  }

  // 返信先の解決（同一root。孫を作らない）
  let replyTo: Pick<Comment, 'commentId' | 'rootCommentId'> | null = null;
  if (input.replyToCommentId) {
    const loc = await resolveCommentLocator(ctx.metaBucket, input.replyToCommentId);
    if (!loc || loc.targetType !== input.targetType || loc.targetId !== input.targetId) {
      throw new AppError(422, 'invalid_reply_target', '返信先が不正です。');
    }
    replyTo = { commentId: input.replyToCommentId, rootCommentId: loc.rootCommentId };
  }

  const commentId = ulid();
  const rootCommentId = resolveRootCommentId(commentId, replyTo);
  const comment: Comment = {
    commentId,
    targetType: input.targetType,
    targetId: input.targetId,
    rootCommentId,
    replyToCommentId: input.replyToCommentId ?? null,
    body, // 保存は生値（XSSは表示時にエスケープ）
    status: 'active',
    authorUserId: userId,
    createdAt: now,
    deletedAt: null,
  };

  // 正本を先、locator を後
  await putJsonIfAbsent(
    ctx.metaBucket,
    metaKeys.comment(input.targetType, input.targetId, rootCommentId, commentId),
    comment,
  );
  await createCommentLocator(ctx.metaBucket, commentId, {
    targetType: input.targetType,
    targetId: input.targetId,
    rootCommentId,
  });
  return comment;
}

/** コメントを削除する（投稿者または管理者）。親=墓標、子=非表示。 */
export async function deleteComment(
  ctx: AppContext,
  commentId: string,
  userId: string,
  now: string,
): Promise<void> {
  const loc = await resolveCommentLocator(ctx.metaBucket, commentId);
  if (!loc) throw notFoundOrForbidden('コメントが見つかりません。');

  const commentKey = metaKeys.comment(loc.targetType, loc.targetId, loc.rootCommentId, commentId);
  const rec = await getJson<Comment>(ctx.metaBucket, commentKey);
  if (!rec) throw notFoundOrForbidden('コメントが見つかりません。');

  // 対象アルバムの正本で削除権限を判定
  const access = await authorizeTarget(ctx, loc.targetType, loc.targetId, userId);
  if (!canDeleteComment(access.album.value, rec.value, userId, access.group)) {
    throw forbidden('このコメントを削除する権限がありません。');
  }

  if (rec.value.status === 'deleted') return; // 冪等

  // 親も子も markDeleted（本文を空に・status=deleted）。他コメントは変更しない（非破壊）。
  const updated = markDeleted(rec.value, now);
  await putJsonIfMatch(ctx.metaBucket, commentKey, updated, rec.etag);
}
