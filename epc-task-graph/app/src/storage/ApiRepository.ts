// ============================================================================
// ApiRepository — サーバー版（Azure Functions + SQL）の GraphRepository 実装（§6.1/§7.2）。
// 契約は apiContract.ts。認証は SWA が付与する Cookie（same-origin）で、クライアントは意識しない。
// 未ログイン(401)は AuthRequiredError、権限なし(403)は ForbiddenError、検証エラー(422)は
// ServerValidationError、競合(409)は savePatch の戻り値 {ok:false} で表す。
// ============================================================================
import { migrateDoc, repairDoc, type GraphDoc } from '../domain';
import type {
  ApiError,
  ChangesResponse,
  DuplicateRequest,
  GraphResponse,
  MeResponse,
  Member,
  MemberUpsertRequest,
  PatchConflictResponse,
  PatchOkResponse,
  ProjectRole,
  ProjectSummary,
  SaveGraphResponse,
} from './apiContract';
import type { GraphPatch, GraphRepository, PatchResult, SnapshotMeta } from './GraphRepository';
import { API_BASE } from './mode';

export class AuthRequiredError extends Error {
  constructor() {
    super('ログインが必要です');
    this.name = 'AuthRequiredError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'この操作の権限がありません') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(message = '見つかりませんでした') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ServerValidationError extends Error {
  constructor(
    message: string,
    public readonly details: string[],
  ) {
    super(message);
    this.name = 'ServerValidationError';
  }
}

// ネットワーク断・5xx。呼び出し側は未保存のまま保持し、後で再試行する。
export class ApiUnavailableError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = 'ApiUnavailableError';
  }
}

interface RawResponse {
  status: number;
  body: unknown;
}

function errorOf(body: unknown): ApiError['error'] | null {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as ApiError).error;
    if (e && typeof e === 'object') return e;
  }
  return null;
}

async function send(method: string, path: string, payload?: unknown): Promise<RawResponse> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      credentials: 'same-origin',
      // SWA はログイン切れを 302（ログイン画面へ）で返す。追従せず 401 として扱う。
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
  } catch {
    throw new ApiUnavailableError('サーバーに接続できません', null);
  }
  if (res.type === 'opaqueredirect') return { status: 401, body: null };
  let body: unknown = null;
  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
  }
  return { status: res.status, body };
}

function throwForStatus({ status, body }: RawResponse): never {
  const err = errorOf(body);
  const message = err?.message ?? `サーバーエラー (${status})`;
  if (status === 401) throw new AuthRequiredError();
  if (status === 403) throw new ForbiddenError(err?.message);
  if (status === 404) throw new NotFoundError(err?.message);
  if (status === 422) throw new ServerValidationError(message, err?.details?.length ? err.details : [message]);
  throw new ApiUnavailableError(message, status);
}

async function call<T>(method: string, path: string, payload?: unknown): Promise<T> {
  const raw = await send(method, path, payload);
  if (raw.status < 200 || raw.status >= 300) throwForStatus(raw);
  return raw.body as T;
}

const pid = (id: string) => encodeURIComponent(id);

// 移行→修復だけを防御的に行う（サーバーが検証済み。スナップショット等の副作用なし）。
function normalizeDoc(raw: GraphDoc): GraphDoc {
  return repairDoc(migrateDoc(raw).doc).doc as GraphDoc;
}

export class ApiRepository implements GraphRepository {
  // 直近に取得/保存したプロジェクトごとの自分の権限（loadGraph 等の応答で更新）。
  private readonly roles = new Map<string, ProjectRole>();

  getRole(projectId: string): ProjectRole | undefined {
    return this.roles.get(projectId);
  }

  me(): Promise<MeResponse> {
    return call<MeResponse>('GET', '/me');
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const list = await call<ProjectSummary[]>('GET', '/projects');
    for (const p of list) this.roles.set(p.id, p.role);
    return list;
  }

  private adopt(res: GraphResponse): GraphDoc {
    const doc = normalizeDoc(res.doc);
    this.roles.set(doc.project.id, res.role);
    return doc;
  }

  async loadGraph(projectId: string): Promise<GraphDoc> {
    return this.adopt(await call<GraphResponse>('GET', `/projects/${pid(projectId)}/graph`));
  }

  async savePatch(patch: GraphPatch): Promise<PatchResult> {
    const raw = await send('POST', `/projects/${pid(patch.projectId)}/patch`, patch);
    if (raw.status === 409) {
      const body = raw.body as PatchConflictResponse | null;
      return {
        ok: false,
        conflicts: (body?.conflicts ?? []).map((c) => ({
          entity: c.entity,
          id: c.id,
          baseRev: c.baseRev,
          serverRev: c.serverRev,
          serverRow: c.serverRow,
        })),
      };
    }
    if (raw.status < 200 || raw.status >= 300) throwForStatus(raw);
    const ok = raw.body as PatchOkResponse;
    return { ok: true, version: ok.version, newRevs: ok.newRevs ?? {} };
  }

  async saveGraph(doc: GraphDoc): Promise<{ version: number }> {
    const res = await call<SaveGraphResponse>('PUT', `/projects/${pid(doc.project.id)}/graph`, doc);
    this.roles.set(doc.project.id, res.role);
    return { version: res.version };
  }

  async deleteProject(projectId: string): Promise<void> {
    await call<void>('DELETE', `/projects/${pid(projectId)}`);
    this.roles.delete(projectId);
  }

  async duplicateProject(projectId: string, newName: string): Promise<GraphDoc> {
    const body: DuplicateRequest = { newName };
    return this.adopt(await call<GraphResponse>('POST', `/projects/${pid(projectId)}/duplicate`, body));
  }

  listSnapshots(projectId: string): Promise<SnapshotMeta[]> {
    return call<SnapshotMeta[]>('GET', `/projects/${pid(projectId)}/snapshots`);
  }

  async restoreSnapshot(projectId: string, seq: number): Promise<GraphDoc> {
    return this.adopt(
      await call<GraphResponse>('POST', `/projects/${pid(projectId)}/snapshots/${seq}/restore`),
    );
  }

  // ---- サーバー版のみ ----
  getChanges(projectId: string, since: number): Promise<ChangesResponse> {
    return call<ChangesResponse>('GET', `/projects/${pid(projectId)}/changes?since=${since}`);
  }

  listMembers(projectId: string): Promise<Member[]> {
    return call<Member[]>('GET', `/projects/${pid(projectId)}/members`);
  }

  upsertMember(projectId: string, req: MemberUpsertRequest): Promise<Member[]> {
    return call<Member[]>('PUT', `/projects/${pid(projectId)}/members`, req);
  }

  removeMember(projectId: string, email: string): Promise<Member[]> {
    return call<Member[]>('DELETE', `/projects/${pid(projectId)}/members/${encodeURIComponent(email)}`);
  }
}

let instance: ApiRepository | null = null;
export function getApiRepository(): ApiRepository {
  if (!instance) instance = new ApiRepository();
  return instance;
}

// ログイン画面へ（SWA の組み込み認証）。戻り先は現在のパス。
export function redirectToLogin(): void {
  const here = window.location.pathname + window.location.search + window.location.hash;
  window.location.assign(`/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(here)}`);
}
