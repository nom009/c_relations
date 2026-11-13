import type { Principal } from '../auth/principal';
import { parsePrincipal } from '../auth/principal';
import type { ApiError } from '../contract';
import { HttpError, StoreConfigError, badRequest, unauthorized } from '../errors';
import type { ServerStore } from '../store/types';
import * as svc from '../service/service';

export interface ApiRequest {
  method: string;
  path: string; // 例: /api/projects/abc/graph（/api 接頭辞は有無どちらでも可）
  query: Record<string, string | undefined>;
  body?: unknown;
  principalHeader?: string | null; // x-ms-client-principal の値（解釈は handle 内）
}

export interface ApiResponse {
  status: number;
  body?: unknown;
}

interface RouteCtx {
  store: ServerStore;
  user: Principal;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
}

type RouteHandler = (c: RouteCtx) => unknown | Promise<unknown>;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  pattern: string; // Functions のルートテンプレートと同形式（先頭 api/ なし）
  auth: boolean;
  status?: number; // 成功時ステータス（既定 200）
  run: RouteHandler;
}

// 成功/失敗以外のステータスで本文を返したい場合（409 競合）。
class HttpResult {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {}
}

export const ROUTES: Route[] = [
  { method: 'GET', pattern: 'health', auth: false, run: () => ({ ok: true }) },
  { method: 'GET', pattern: 'me', auth: true, run: (c) => svc.me(c.user) },
  { method: 'GET', pattern: 'projects', auth: true, run: (c) => svc.listProjects(c.store, c.user) },
  { method: 'GET', pattern: 'projects/{id}/graph', auth: true, run: (c) => svc.getGraph(c.store, c.user, c.params.id!) },
  { method: 'PUT', pattern: 'projects/{id}/graph', auth: true, run: (c) => svc.saveGraph(c.store, c.user, c.params.id!, c.body) },
  {
    method: 'POST',
    pattern: 'projects/{id}/patch',
    auth: true,
    run: async (c) => {
      const r = await svc.applyPatch(c.store, c.user, c.params.id!, c.body);
      return r.ok ? r : new HttpResult(409, r);
    },
  },
  { method: 'GET', pattern: 'projects/{id}/changes', auth: true, run: (c) => svc.getChanges(c.store, c.user, c.params.id!, c.query.since) },
  {
    method: 'DELETE',
    pattern: 'projects/{id}',
    auth: true,
    status: 204,
    run: async (c) => {
      await svc.deleteProject(c.store, c.user, c.params.id!);
      return undefined;
    },
  },
  { method: 'POST', pattern: 'projects/{id}/duplicate', auth: true, run: (c) => svc.duplicateProject(c.store, c.user, c.params.id!, c.body) },
  { method: 'GET', pattern: 'projects/{id}/snapshots', auth: true, run: (c) => svc.listSnapshots(c.store, c.user, c.params.id!) },
  {
    method: 'POST',
    pattern: 'projects/{id}/snapshots/{seq}/restore',
    auth: true,
    run: (c) => svc.restoreSnapshot(c.store, c.user, c.params.id!, c.params.seq!),
  },
  { method: 'GET', pattern: 'projects/{id}/members', auth: true, run: (c) => svc.listMembers(c.store, c.user, c.params.id!) },
  { method: 'PUT', pattern: 'projects/{id}/members', auth: true, run: (c) => svc.upsertMember(c.store, c.user, c.params.id!, c.body) },
  { method: 'DELETE', pattern: 'projects/{id}/members/{email}', auth: true, run: (c) => svc.removeMember(c.store, c.user, c.params.id!, c.params.email!) },
];

function match(pattern: string, segs: string[]): Record<string, string> | null {
  const parts = pattern.split('/');
  if (parts.length !== segs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const s = segs[i]!;
    if (p.startsWith('{') && p.endsWith('}')) {
      if (!s) return null;
      params[p.slice(1, -1)] = s;
    } else if (p !== s) return null;
  }
  return params;
}

const errorBody = (code: string, message: string, details?: string[]): ApiError => ({
  error: details ? { code, message, details } : { code, message },
});

export async function handle(req: ApiRequest, getStore: () => ServerStore): Promise<ApiResponse> {
  try {
    let segs: string[];
    try {
      segs = req.path
        .split('?')[0]!
        .split('/')
        .filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));
    } catch {
      throw badRequest('URL が不正です');
    }
    if (segs[0] === 'api') segs.shift();

    const candidates = ROUTES.map((r) => ({ r, params: match(r.pattern, segs) })).filter((x) => x.params);
    if (candidates.length === 0) return { status: 404, body: errorBody('not_found', 'エンドポイントが見つかりません') };
    const method = req.method.toUpperCase();
    const hit = candidates.find((x) => x.r.method === method);
    if (!hit) return { status: 405, body: errorBody('method_not_allowed', 'メソッドが許可されていません') };

    const route = hit.r;
    let user: Principal | null = null;
    if (route.auth) {
      user = parsePrincipal(req.principalHeader);
      if (!user) throw unauthorized();
    }
    const out = await route.run({
      store: route.auth ? getStore() : (undefined as unknown as ServerStore),
      user: user as Principal,
      params: hit.params!,
      query: req.query,
      body: req.body,
    });
    if (out instanceof HttpResult) return { status: out.status, body: out.body };
    return route.status === 204 ? { status: 204 } : { status: route.status ?? 200, body: out };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: errorBody(e.code, e.message, e.details) };
    if (e instanceof StoreConfigError) {
      console.error('[api] store configuration error:', e.message);
      return { status: 500, body: errorBody('server_misconfigured', 'サーバーの保存先が構成されていません') };
    }
    console.error('[api] unhandled error', e);
    return { status: 500, body: errorBody('internal_error', 'サーバー内部エラーが発生しました') };
  }
}
