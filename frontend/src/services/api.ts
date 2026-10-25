// 型付きAPIクライアント。shared の型を用い、同一オリジンの /api を呼ぶ。
// エラーは ApiError を投げる（画面側で code 分岐・message 表示）。

import type {
  ApiError,
  Album,
  Group,
  MediaListItem,
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
    const err = (data ?? { code: 'unknown', message: '不明なエラー' }) as ApiError;
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
  me: () => request<{ userId: string }>('GET', '/api/me'),

  groups: {
    list: () => request<{ groups: Group[] }>('GET', '/api/groups'),
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
    revokeInvite: (groupId: string, inviteId: string) =>
      request<void>('POST', `/api/invites/${encodeURIComponent(inviteId)}/revoke`, { groupId }),
    acceptInvite: (token: string) =>
      request<{ groupId: string }>('POST', '/api/invites/accept', { token }),
  },

  albums: {
    list: () => request<{ albums: Album[] }>('GET', '/api/albums'),
    create: (input: { ownerType: OwnerType; ownerId: string; title: string; description?: string }) =>
      request<Album>('POST', '/api/albums', input),
    get: (albumId: string) => request<Album>('GET', `/api/albums/${encodeURIComponent(albumId)}`),
    update: (albumId: string, input: { title?: string; description?: string; coverMediaId?: string | null }) =>
      request<Album>('PATCH', `/api/albums/${encodeURIComponent(albumId)}`, input),
    media: (albumId: string, pageToken?: string) =>
      request<{ items: MediaListItem[]; nextToken?: string }>(
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
    complete: (mediaId: string, uploadId: string, parts: { partNumber: number; etag: string }[]) =>
      request<void>(
        'POST',
        `/api/media/${encodeURIComponent(mediaId)}/uploads/${encodeURIComponent(uploadId)}/complete`,
        { parts },
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
  },

  comments: {
    list: (targetType: 'album' | 'media', targetId: string) =>
      request<{ threads: unknown[] }>(
        'GET',
        `/api/comments?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}`,
      ),
    post: (input: { targetType: 'album' | 'media'; targetId: string; body: string; replyToCommentId?: string | null }) =>
      request('POST', '/api/comments', input),
    remove: (commentId: string) =>
      request<void>('DELETE', `/api/comments/${encodeURIComponent(commentId)}`),
  },
};
