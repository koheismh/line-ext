// 型付きAPIクライアント。shared の型を用い、同一オリジンの /api を呼ぶ。
// エラーは ApiError を投げる（画面側で code 分岐・message 表示）。

import type {
  ApiError,
  Album,
  AlbumListItem,
  Comment,
  CommentListResponse,
  Group,
  GroupSummary,
  InviteSummary,
  MediaPage,
  MeResponse,
  MultipartInit,
  OwnerType,
  SignedUrlKind,
} from '@photo-album/shared';

/** APIエラーを表す例外。HTTPステータスと機械可読コードを保持。 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, body: ApiError) {
    super(body.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = body.code;
  }
}

/** 画面に出す利用者向けメッセージ（APIエラーはサーバの説明、それ以外は既定文）。 */
export function errorMessage(err: unknown, fallback = '通信に失敗しました。時間をおいて再度お試しください。'): string {
  return err instanceof ApiClientError ? err.message : fallback;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin', // セッションCookieを送る
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204 || res.status === 202) {
    // 本文なし/受理
    return (res.status === 202 ? await safeJson(res) : undefined) as T;
  }

  const data = await safeJson(res);
  if (!res.ok) {
    const err = (data ?? { code: 'unknown', message: '不明なエラーが発生しました。' }) as ApiError;
    throw new ApiClientError(res.status, err);
  }
  return data as T;
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---- 各API ----

export const api = {
  me: () => request<MeResponse>('GET', '/api/me'),

  auth: {
    logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  },

  groups: {
    list: () => request<{ groups: GroupSummary[] }>('GET', '/api/groups'),
    create: (name: string) => request<Group>('POST', '/api/groups', { name }),
    detail: (groupId: string) =>
      request<{ group: Group; members: { userId: string; displayName: string }[] }>(
        'GET',
        `/api/groups/${encodeURIComponent(groupId)}`,
      ),
    issueInvite: (groupId: string) =>
      request<{ inviteId: string; token: string; expiresAt: string }>(
        'POST',
        `/api/groups/${encodeURIComponent(groupId)}/invites`,
      ),
    invites: (groupId: string) =>
      request<{ invites: InviteSummary[] }>(
        'GET',
        `/api/groups/${encodeURIComponent(groupId)}/invites`,
      ),
    revokeInvite: (inviteId: string) =>
      request<void>('POST', `/api/invites/${encodeURIComponent(inviteId)}/revoke`),
    acceptInvite: (token: string) =>
      request<{ groupId: string }>('POST', '/api/invites/accept', { token }),
  },

  albums: {
    list: () => request<{ albums: AlbumListItem[] }>('GET', '/api/albums'),
    create: (input: { ownerType: OwnerType; ownerId: string; title: string; description?: string }) =>
      request<Album>('POST', '/api/albums', input),
    get: (albumId: string) => request<Album>('GET', `/api/albums/${encodeURIComponent(albumId)}`),
    update: (albumId: string, input: { title?: string; description?: string; coverMediaId?: string | null }) =>
      request<Album>('PATCH', `/api/albums/${encodeURIComponent(albumId)}`, input),
    media: (albumId: string, pageToken?: string) =>
      request<MediaPage>(
        'GET',
        `/api/albums/${encodeURIComponent(albumId)}/media${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      ),
  },

  uploads: {
    initSingle: (
      albumId: string,
      input: { declaredMimeType: string; declaredByteSize: number; displayFileName: string; fileLastModified?: string | null },
    ) =>
      request<{ mediaId: string; uploadUrl: string }>(
        'POST',
        `/api/albums/${encodeURIComponent(albumId)}/media/uploads`,
        input,
      ),
    initMultipart: (
      albumId: string,
      input: {
        declaredMimeType: string;
        declaredByteSize: number;
        displayFileName: string;
        fileLastModified?: string | null;
        partCount: number;
      },
    ) =>
      request<MultipartInit>(
        'POST',
        `/api/albums/${encodeURIComponent(albumId)}/media/uploads/multipart`,
        input,
      ),
    reissueParts: (mediaId: string, uploadId: string, partNumbers: number[]) =>
      request<{ partNumber: number; url: string }[]>(
        'POST',
        `/api/media/${encodeURIComponent(mediaId)}/uploads/${encodeURIComponent(uploadId)}/parts`,
        { partNumbers },
      ),
    /** 完了。パートの ETag・サイズはサーバが ListParts で取得・検証する。 */
    complete: (mediaId: string, uploadId: string) =>
      request<void>(
        'POST',
        `/api/media/${encodeURIComponent(mediaId)}/uploads/${encodeURIComponent(uploadId)}/complete`,
        {},
      ),
  },

  media: {
    url: (mediaId: string, kind: SignedUrlKind) =>
      request<{ url: string }>(
        'GET',
        `/api/media/${encodeURIComponent(mediaId)}/url?kind=${kind}`,
      ),
    remove: (mediaId: string) =>
      request<{ mediaId: string; albumId: string }>(
        'DELETE',
        `/api/media/${encodeURIComponent(mediaId)}`,
      ),
    reprocess: (mediaId: string) =>
      request<void>('POST', `/api/media/${encodeURIComponent(mediaId)}/reprocess`),
  },

  comments: {
    list: (targetType: 'album' | 'media', targetId: string, pageToken?: string) =>
      request<CommentListResponse>(
        'GET',
        `/api/comments?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}${
          pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
        }`,
      ),
    post: (input: { targetType: 'album' | 'media'; targetId: string; body: string; replyToCommentId?: string | null }) =>
      request<Comment>('POST', '/api/comments', input),
    remove: (commentId: string) =>
      request<void>('DELETE', `/api/comments/${encodeURIComponent(commentId)}`),
  },
};
