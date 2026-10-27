// APIルーター（handler層）。API Gateway HTTP API v2 の単一Lambdaで全ルートを捌く。
// メソッド＋パスでユースケースへディスパッチし、認証・CSRF・エラー変換を一元化する。
// ルート一覧は structure.md「API境界」に準拠。

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { MeResponse, SignedUrlKind } from '@photo-album/shared';
import { authenticate, requireUser, type RequestMeta } from './authMiddleware.js';
import { handleLineStart, handleLineCallback, handleLogout } from './authFlow.js';
import { handle, ok, noContent, type HttpResponse } from './http.js';
import { loadRuntimeConfig, type RuntimeConfig } from './runtimeConfig.js';
import { enqueueDeletion } from './jobs.js';
import { buildSessionCookie } from '../auth/cookie.js';
import * as groups from '../app/groups.js';
import * as albums from '../app/albums.js';
import * as uploads from '../app/uploads.js';
import * as mediaQuery from '../app/mediaQuery.js';
import * as deletion from '../app/deletion.js';
import * as processing from '../app/processing.js';
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

/** JSONボディを読む。オブジェクト以外は 422（各項目の検証はユースケース側で行う）。 */
function parseBody<T>(event: APIGatewayProxyEventV2): Partial<T> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(422, 'invalid_json', 'リクエストボディが不正です。');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError(422, 'invalid_json', 'リクエストボディが不正です。');
  }
  return parsed as Partial<T>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** ルート定義。method と、パスのセグメントパターンでマッチする。cfg は呼び出し側で解決して渡す。 */
export async function route(
  event: APIGatewayProxyEventV2,
  cfg: RuntimeConfig,
): Promise<HttpResponse> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const q = event.queryStringParameters ?? {};
  const meta = reqMeta(event);
  const { app } = cfg;

  const auth = () => requireUser(app, meta, cfg.secrets.cookieSecret, cfg.allowedOrigin);

  return handle(async () => {
    // --- 認証不要 ---
    if (method === 'GET' && path === '/api/health') {
      return ok({ status: 'ok' });
    }
    // 認証フロー（ログイン前に呼ばれる）
    if (method === 'GET' && path === '/api/auth/line/start') {
      return handleLineStart(event, cfg);
    }
    if (method === 'GET' && path === '/api/auth/line/callback') {
      return handleLineCallback(event, cfg);
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      return handleLogout(event, cfg, meta);
    }

    // --- /api/me（Cookieを延長して実質無期限にする） ---
    if (method === 'GET' && path === '/api/me') {
      const session = await authenticate(app, meta, cfg.secrets.cookieSecret, cfg.allowedOrigin);
      const body: MeResponse = { userId: session.userId, displayName: session.user.displayName };
      return ok(body, { cookies: [buildSessionCookie(session.token)] });
    }

    // --- groups ---
    if (method === 'GET' && path === '/api/groups') {
      const userId = await auth();
      return ok({ groups: await groups.listGroups(app, userId) });
    }
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
    if (method === 'GET' && groupInvites) {
      const userId = await auth();
      return ok({ invites: await groups.listInvites(app, groupInvites[1]!, userId, Date.now()) });
    }
    const inviteRevoke = path.match(/^\/api\/invites\/([^/]+)\/revoke$/);
    if (method === 'POST' && inviteRevoke) {
      const userId = await auth();
      await groups.revokeInvite(app, inviteRevoke[1]!, userId, nowIso());
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
      return ok(
        await albums.createAlbum(
          app,
          userId,
          {
            ownerType: body.ownerType as 'user' | 'group',
            ownerId: body.ownerId as string,
            title: body.title as string,
            ...(body.description !== undefined ? { description: body.description } : {}),
          },
          nowIso(),
        ),
        { statusCode: 201 },
      );
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
          ...(body as Omit<uploads.InitUploadParams, 'albumId' | 'userId' | 'now'>),
          albumId: albumUploads[1]!,
          userId,
          now: nowIso(),
        }),
      );
    }
    const albumMultipart = path.match(/^\/api\/albums\/([^/]+)\/media\/uploads\/multipart$/);
    if (method === 'POST' && albumMultipart) {
      const userId = await auth();
      type Body = Omit<uploads.InitUploadParams, 'albumId' | 'userId' | 'now'> & { partCount: number };
      const body = parseBody<Body>(event) as Body;
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
          partNumbers: body.partNumbers ?? [],
        }),
      );
    }
    const mediaComplete = path.match(/^\/api\/media\/([^/]+)\/uploads\/([^/]+)\/complete$/);
    if (method === 'POST' && mediaComplete) {
      const userId = await auth();
      // クライアント申告のパート情報は使わない（サーバが ListParts で取得・検証する）
      await uploads.completeUpload(app, {
        mediaId: mediaComplete[1]!,
        uploadId: mediaComplete[2]!,
        userId,
        now: nowIso(),
      });
      return noContent();
    }
    const mediaUrl = path.match(/^\/api\/media\/([^/]+)\/url$/);
    if (method === 'GET' && mediaUrl) {
      const userId = await auth();
      const kind = (q.kind ?? 'preview') as SignedUrlKind; // 値の検証は getMediaUrl で行う
      return ok({ url: await mediaQuery.getMediaUrl(app, mediaUrl[1]!, userId, kind) });
    }
    const mediaReprocess = path.match(/^\/api\/media\/([^/]+)\/reprocess$/);
    if (method === 'POST' && mediaReprocess) {
      const userId = await auth();
      await processing.requestReprocess(app, mediaReprocess[1]!, userId);
      return noContent(202);
    }
    const mediaOne = path.match(/^\/api\/media\/([^/]+)$/);
    if (method === 'DELETE' && mediaOne) {
      const userId = await auth();
      const job = await deletion.startDelete(app, mediaOne[1]!, userId, new Date());
      // コピー以降は SQS 経由の削除ワーカーで非同期に行う（投入失敗時は定期掃除が再投入）
      await enqueueDeletion(cfg.deletionQueueUrl, job);
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
      return ok(
        await comments.listComments(app, targetType, targetId, userId, {
          ...(q.pageToken ? { pageToken: q.pageToken } : {}),
        }),
      );
    }
    if (method === 'POST' && path === '/api/comments') {
      const userId = await auth();
      const body = parseBody<comments.PostCommentInput>(event) as comments.PostCommentInput;
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
  const cfg = await loadRuntimeConfig();
  const res = await route(event, cfg);
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body,
    ...(res.cookies ? { cookies: res.cookies } : {}),
  };
}
