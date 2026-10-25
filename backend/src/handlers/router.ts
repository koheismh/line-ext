// APIルーター（handler層）。API Gateway HTTP API v2 の単一Lambdaで全ルートを捌く。
// メソッド＋パスでユースケースへディスパッチし、認証・CSRF・エラー変換を一元化する。

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { safeReturnPath } from '../auth/index.js';
import { requireUser, type RequestMeta } from './authMiddleware.js';
import { handle, ok, noContent, type HttpResponse } from './http.js';
import { loadRuntimeConfig, type RuntimeConfig } from './runtimeConfig.js';
import * as groups from '../app/groups.js';
import * as albums from '../app/albums.js';
import * as uploads from '../app/uploads.js';
import * as mediaQuery from '../app/mediaQuery.js';
import * as deletion from '../app/deletion.js';
import * as comments from '../app/comments.js';
import { AppError } from '../app/errors.js';

function reqMeta(event: APIGatewayProxyEventV2): RequestMeta {
  const h = event.headers ?? {};
  return {
    method: event.requestContext.http.method,
    cookieHeader: (event.cookies ?? []).join('; ') || h['cookie'] || h['Cookie'],
    origin: h['origin'] ?? h['Origin'],
    referer: h['referer'] ?? h['Referer'],
  };
}

function parseBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) return {} as T;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new AppError(422, 'invalid_json', 'リクエストボディが不正です。');
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** ルート定義。method と、パスのセグメントパターンでマッチする。 */
export async function route(
  event: APIGatewayProxyEventV2,
  cfg: RuntimeConfig = loadRuntimeConfig(),
): Promise<HttpResponse> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const q = event.queryStringParameters ?? {};
  const meta = reqMeta(event);
  const { app } = cfg;

  const auth = () => requireUser(app, meta, cfg.cookieSecret, cfg.allowedOrigin);

  return handle(async () => {
    // --- 認証不要（start/callbackは別ハンドラ想定だが骨格のみ） ---
    if (method === 'GET' && path === '/api/health') {
      return ok({ status: 'ok' });
    }

    // --- /api/me ---
    if (method === 'GET' && path === '/api/me') {
      const userId = await auth();
      return ok({ userId });
    }

    // --- groups ---
    if (method === 'POST' && path === '/api/groups') {
      const userId = await auth();
      const body = parseBody<{ name: string }>(event);
      const g = await groups.createGroup(app, userId, body.name, nowIso());
      return ok(g, { statusCode: 201 });
    }
    const groupDetail = path.match(/^\/api\/groups\/([^/]+)$/);
    if (method === 'GET' && groupDetail) {
      const userId = await auth();
      return ok(await groups.getGroupDetail(app, groupDetail[1]!, userId));
    }
    const groupInvites = path.match(/^\/api\/groups\/([^/]+)\/invites$/);
    if (method === 'POST' && groupInvites) {
      const userId = await auth();
      return ok(await groups.issueInvite(app, groupInvites[1]!, userId, Date.now()), {
        statusCode: 201,
      });
    }
    const inviteRevoke = path.match(/^\/api\/invites\/([^/]+)\/revoke$/);
    if (method === 'POST' && inviteRevoke) {
      const userId = await auth();
      const body = parseBody<{ groupId: string }>(event);
      await groups.revokeInvite(app, body.groupId, inviteRevoke[1]!, userId, nowIso());
      return noContent();
    }
    if (method === 'POST' && path === '/api/invites/accept') {
      const userId = await auth();
      const body = parseBody<{ token: string }>(event);
      return ok(await groups.acceptInvite(app, body.token, userId, Date.now()));
    }

    // --- albums ---
    if (method === 'GET' && path === '/api/albums') {
      const userId = await auth();
      return ok({ albums: await albums.listAlbums(app, userId) });
    }
    if (method === 'POST' && path === '/api/albums') {
      const userId = await auth();
      const body = parseBody<{
        ownerType: 'user' | 'group';
        ownerId: string;
        title: string;
        description?: string;
      }>(event);
      return ok(await albums.createAlbum(app, userId, body, nowIso()), { statusCode: 201 });
    }
    const albumOne = path.match(/^\/api\/albums\/([^/]+)$/);
    if (method === 'GET' && albumOne) {
      const userId = await auth();
      return ok(await albums.getAlbum(app, albumOne[1]!, userId));
    }
    if (method === 'PATCH' && albumOne) {
      const userId = await auth();
      const body = parseBody<albums.UpdateAlbumInput>(event);
      return ok(await albums.updateAlbum(app, albumOne[1]!, userId, body, nowIso()));
    }

    // --- album media ---
    const albumMedia = path.match(/^\/api\/albums\/([^/]+)\/media$/);
    if (method === 'GET' && albumMedia) {
      const userId = await auth();
      return ok(
        await mediaQuery.listAlbumMedia(app, albumMedia[1]!, userId, {
          ...(q.pageToken ? { pageToken: q.pageToken } : {}),
        }),
      );
    }
    const albumUploads = path.match(/^\/api\/albums\/([^/]+)\/media\/uploads$/);
    if (method === 'POST' && albumUploads) {
      const userId = await auth();
      const body = parseBody<Omit<uploads.InitUploadParams, 'albumId' | 'userId' | 'now'>>(event);
      return ok(
        await uploads.initSingleUpload(app, {
          ...body,
          albumId: albumUploads[1]!,
          userId,
          now: nowIso(),
        }),
      );
    }
    const albumMultipart = path.match(/^\/api\/albums\/([^/]+)\/media\/uploads\/multipart$/);
    if (method === 'POST' && albumMultipart) {
      const userId = await auth();
      const body = parseBody<
        Omit<uploads.InitUploadParams, 'albumId' | 'userId' | 'now'> & { partCount: number }
      >(event);
      return ok(
        await uploads.initMultipartUpload(app, {
          ...body,
          albumId: albumMultipart[1]!,
          userId,
          now: nowIso(),
        }),
      );
    }

    // --- media ---
    const mediaParts = path.match(/^\/api\/media\/([^/]+)\/uploads\/([^/]+)\/parts$/);
    if (method === 'POST' && mediaParts) {
      const userId = await auth();
      const body = parseBody<{ partNumbers: number[] }>(event);
      return ok(
        await uploads.reissuePartUrls(app, {
          mediaId: mediaParts[1]!,
          uploadId: mediaParts[2]!,
          userId,
          partNumbers: body.partNumbers,
        }),
      );
    }
    const mediaComplete = path.match(/^\/api\/media\/([^/]+)\/uploads\/([^/]+)\/complete$/);
    if (method === 'POST' && mediaComplete) {
      const userId = await auth();
      const body = parseBody<{ parts: { partNumber: number; etag: string }[] }>(event);
      await uploads.completeUpload(app, {
        mediaId: mediaComplete[1]!,
        uploadId: mediaComplete[2]!,
        userId,
        parts: body.parts,
        now: nowIso(),
      });
      return noContent();
    }
    const mediaUrl = path.match(/^\/api\/media\/([^/]+)\/url$/);
    if (method === 'GET' && mediaUrl) {
      const userId = await auth();
      const kind = (q.kind ?? 'preview') as 'preview' | 'original' | 'video' | 'download';
      return ok({ url: await mediaQuery.getMediaUrl(app, mediaUrl[1]!, userId, kind) });
    }
    const mediaOne = path.match(/^\/api\/media\/([^/]+)$/);
    if (method === 'DELETE' && mediaOne) {
      const userId = await auth();
      const job = await deletion.startDelete(app, mediaOne[1]!, userId, new Date());
      // 実際のSQS投入はこの後（インフラ結線）。ここでは受理を202で返す。
      return ok(job, { statusCode: 202 });
    }

    // --- comments ---
    if (method === 'GET' && path === '/api/comments') {
      const userId = await auth();
      const targetType = q.targetType as 'album' | 'media';
      const targetId = q.targetId ?? '';
      if (!targetType || !targetId) {
        throw new AppError(422, 'invalid_query', 'targetType と targetId は必須です。');
      }
      return ok({ threads: await comments.listComments(app, targetType, targetId, userId) });
    }
    if (method === 'POST' && path === '/api/comments') {
      const userId = await auth();
      const body = parseBody<comments.PostCommentInput>(event);
      return ok(await comments.postComment(app, userId, body, nowIso()), { statusCode: 201 });
    }
    const commentOne = path.match(/^\/api\/comments\/([^/]+)$/);
    if (method === 'DELETE' && commentOne) {
      const userId = await auth();
      await comments.deleteComment(app, commentOne[1]!, userId, nowIso());
      return noContent();
    }

    // 未定義ルート
    throw new AppError(404, 'not_found', 'エンドポイントが見つかりません。');
  });
}

/** Lambda ハンドラ。HttpResponse を API Gateway v2 形式へ変換する。 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = await route(event);
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body,
    ...(res.cookies ? { cookies: res.cookies } : {}),
  };
}

// safeReturnPath は auth/callback ハンドラ実装時に使用する（将来結線）。
void safeReturnPath;
