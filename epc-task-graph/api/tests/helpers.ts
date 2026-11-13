import { expect } from 'vitest';
import { encodePrincipal } from '../src/auth/principal';
import { emptyDoc, makeDep, makeTask, newId } from '../src/domain';
import type { Dependency, GraphDoc, Task } from '../src/domain';
import type { GraphPatch } from '../src/contract';
import { handle } from '../src/http/router';
import type { ApiResponse } from '../src/http/router';
import type { ServerStore } from '../src/store/types';

export interface TestUser {
  email: string;
  name: string;
  header: string;
}

// テストごとに一意なユーザー（実 DB に対する統合テストでも他テストの影響を受けない）。
export function makeUser(tag: string): TestUser {
  const suffix = newId().slice(0, 8);
  const email = `${tag}.${suffix}@example.com`;
  const name = `${tag}-name`;
  // userDetails は大文字混じりにして、小文字化されることも確認する。
  const header = encodePrincipal({ userId: `uid-${tag}-${suffix}`, userDetails: email.toUpperCase(), name });
  return { email, name, header };
}

export type Api = (user: TestUser | null, method: string, url: string, body?: unknown) => Promise<ApiResponse>;

export function makeApi(store: ServerStore): Api {
  return (user, method, url, body) => {
    const i = url.indexOf('?');
    const path = i < 0 ? url : url.slice(0, i);
    const query: Record<string, string | undefined> = {};
    new URLSearchParams(i < 0 ? '' : url.slice(i + 1)).forEach((v, k) => {
      query[k] = v;
    });
    return handle({ method, path: '/api' + path, query, body, principalHeader: user?.header ?? null }, () => store);
  };
}

export interface Seed {
  doc: GraphDoc;
  pid: string;
  a: Task;
  b: Task;
  c: Task;
  dab: Dependency;
}

// タスク a,b,c と依存 a→b を持つプロジェクトを owner が作成する。
export async function seedProject(api: Api, owner: TestUser): Promise<Seed> {
  const doc = emptyDoc('P1');
  const a = makeTask({ id: newId(), name: 'A' });
  const b = makeTask({ id: newId(), name: 'B' });
  const c = makeTask({ id: newId(), name: 'C' });
  const dab = makeDep(a.id, b.id, { id: newId() });
  doc.tasks = [a, b, c];
  doc.dependencies = [dab];
  const pid = doc.project.id;
  const res = await api(owner, 'PUT', `/projects/${pid}/graph`, doc);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ version: 1, role: 'owner' });
  return { doc, pid, a, b, c, dab };
}

export const emptyPatch = (pid: string): GraphPatch => ({
  projectId: pid,
  baseProjectVersion: 0,
  upsertTasks: [],
  deleteTaskIds: [],
  upsertDeps: [],
  deleteDepIds: [],
});

export async function addMember(api: Api, owner: TestUser, pid: string, who: TestUser, role: string): Promise<void> {
  const res = await api(owner, 'PUT', `/projects/${pid}/members`, { email: who.email, role });
  expect(res.status).toBe(200);
}
