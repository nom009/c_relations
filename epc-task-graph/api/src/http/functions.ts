import { app } from '@azure/functions';
import type { HttpRequest, HttpResponseInit } from '@azure/functions';
import { PRINCIPAL_HEADER } from '../auth/principal';
import { getStore } from '../store';
import { PAYLOAD_TOO_LARGE_BODY, isBodyTooLarge } from './bodyLimit';
import { ROUTES, handle } from './router';

async function readBody(req: HttpRequest): Promise<{ ok: true; body: unknown } | { ok: false; tooLarge?: boolean }> {
  if (isBodyTooLarge(req.headers.get('content-length'))) return { ok: false, tooLarge: true };
  const text = await req.text();
  if (isBodyTooLarge(null, text)) return { ok: false, tooLarge: true };
  if (!text.trim()) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

async function handler(req: HttpRequest): Promise<HttpResponseInit> {
  const hasBody = req.method === 'POST' || req.method === 'PUT';
  let body: unknown;
  if (hasBody) {
    const r = await readBody(req);
    if (!r.ok) {
      if (r.tooLarge) return { status: 413, jsonBody: PAYLOAD_TOO_LARGE_BODY, headers: { 'cache-control': 'no-store' } };
      return {
        status: 400,
        jsonBody: { error: { code: 'bad_request', message: 'JSON の形式が不正です' } },
        headers: { 'cache-control': 'no-store' },
      };
    }
    body = r.body;
  }
  const query: Record<string, string | undefined> = {};
  req.query.forEach((v, k) => {
    query[k] = v;
  });
  const res = await handle(
    {
      method: req.method,
      path: new URL(req.url).pathname,
      query,
      body,
      principalHeader: req.headers.get(PRINCIPAL_HEADER),
    },
    getStore,
  );
  const init: HttpResponseInit = { status: res.status, headers: { 'cache-control': 'no-store' } };
  if (res.body !== undefined) init.jsonBody = res.body;
  return init;
}

// 同じルートテンプレートのメソッドをまとめて 1 関数として登録（振り分けは handle 内）。
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const grouped = new Map<string, Set<Method>>();
for (const r of ROUTES) {
  const set = grouped.get(r.pattern) ?? new Set<Method>();
  set.add(r.method);
  grouped.set(r.pattern, set);
}
for (const [pattern, methods] of grouped) {
  app.http('api-' + pattern.replace(/[^A-Za-z0-9]+/g, '-').replace(/-$/, ''), {
    methods: [...methods],
    authLevel: 'anonymous', // 認証は SWA が前段で実施（x-ms-client-principal）
    route: pattern,
    handler,
  });
}
