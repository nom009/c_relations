import { describe, expect, it } from 'vitest';
import { makeDep, makeTask, newId } from '../src/domain';
import type { GraphDoc, Task } from '../src/domain';
import type {
  ChangesResponse,
  GraphResponse,
  Member,
  PatchConflictResponse,
  PatchOkResponse,
  ProjectSummary,
  SnapshotMeta,
} from '../src/contract';
import type { ServerStore } from '../src/store/types';
import { addMember, emptyPatch, makeApi, makeUser, seedProject } from './helpers';

// MemoryStore / SqlStore 共通のシナリオ。同じ期待値で両実装を検証する。
export function defineApiScenarios(makeStore: () => ServerStore): void {
  const setup = () => {
    const store = makeStore();
    const api = makeApi(store);
    return { api, alice: makeUser('alice'), bob: makeUser('bob'), carol: makeUser('carol') };
  };

  describe('認証・メンバーシップ', () => {
    it('未認証・不正ヘッダーは 401、health は認証不要', async () => {
      const { api } = setup();
      expect((await api(null, 'GET', '/me')).status).toBe(401);
      expect((await api(null, 'GET', '/projects')).status).toBe(401);
      const bad = { email: 'x', name: 'x', header: 'not-base64-json' };
      expect((await api(bad, 'GET', '/projects')).status).toBe(401);
      const h = await api(null, 'GET', '/health');
      expect(h).toEqual({ status: 200, body: { ok: true } });
    });

    it('/me は小文字化した email を返す', async () => {
      const { api, alice } = setup();
      const res = await api(alice, 'GET', '/me');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ email: alice.email, name: alice.name });
    });

    it('非メンバーは 404、一覧にも出ない', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      expect((await api(bob, 'GET', `/projects/${s.pid}/graph`)).status).toBe(404);
      expect((await api(bob, 'GET', `/projects/${s.pid}/changes?since=0`)).status).toBe(404);
      expect((await api(bob, 'POST', `/projects/${s.pid}/patch`, emptyPatch(s.pid))).status).toBe(404);
      expect((await api(bob, 'PUT', `/projects/${s.pid}/graph`, s.doc)).status).toBe(404);
      expect((await api(bob, 'DELETE', `/projects/${s.pid}`)).status).toBe(404);
      expect((await api(bob, 'GET', '/projects')).body).toEqual([]);
    });

    it('viewer は閲覧のみ（patch / PUT / restore は 403）', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      await addMember(api, alice, s.pid, bob, 'viewer');
      const g = await api(bob, 'GET', `/projects/${s.pid}/graph`);
      expect(g.status).toBe(200);
      expect((g.body as GraphResponse).role).toBe('viewer');
      expect((await api(bob, 'POST', `/projects/${s.pid}/patch`, emptyPatch(s.pid))).status).toBe(403);
      expect((await api(bob, 'PUT', `/projects/${s.pid}/graph`, s.doc)).status).toBe(403);
      expect((await api(bob, 'POST', `/projects/${s.pid}/snapshots/1/restore`)).status).toBe(403);
      expect((await api(bob, 'GET', `/projects/${s.pid}/members`)).status).toBe(200);
      expect((await api(bob, 'PUT', `/projects/${s.pid}/members`, { email: 'x@example.com', role: 'viewer' })).status).toBe(403);
      expect((await api(bob, 'DELETE', `/projects/${s.pid}`)).status).toBe(403);
    });
  });

  describe('graph / patch', () => {
    it('GET graph は全行と呼び出し者の viewState を返す', async () => {
      const { api, alice } = setup();
      const s = await seedProject(api, alice);
      const res = await api(alice, 'GET', `/projects/${s.pid}/graph`);
      const g = res.body as GraphResponse;
      expect(g.role).toBe('owner');
      expect(g.doc.tasks.map((t) => t.id).sort()).toEqual([s.a.id, s.b.id, s.c.id].sort());
      expect(g.doc.tasks.every((t) => t.rev === 1 && t.updatedBy === alice.email)).toBe(true);
      expect(g.doc.dependencies).toHaveLength(1);
      expect(g.doc.project.version).toBe(1);
    });

    it('PUT graph の不正（循環・新しい schemaVersion・ID 不一致）は 422', async () => {
      const { api, alice } = setup();
      const s = await seedProject(api, alice);
      const cyc: GraphDoc = {
        ...s.doc,
        dependencies: [s.dab, makeDep(s.b.id, s.a.id, { id: newId() })],
      };
      expect((await api(alice, 'PUT', `/projects/${s.pid}/graph`, cyc)).status).toBe(422);
      const newer = { ...s.doc, schemaVersion: 9999 };
      expect((await api(alice, 'PUT', `/projects/${s.pid}/graph`, newer)).status).toBe(422);
      expect((await api(alice, 'PUT', `/projects/${newId()}/graph`, s.doc)).status).toBe(422);
      const g = (await api(alice, 'GET', `/projects/${s.pid}/graph`)).body as GraphResponse;
      expect(g.doc.project.version).toBe(1);
    });

    it('PUT graph の再保存は rev を +1 し、消えた行は墓標になる', async () => {
      const { api, alice } = setup();
      const s = await seedProject(api, alice);
      const next: GraphDoc = { ...s.doc, tasks: [s.a, s.b], dependencies: [] };
      const put = await api(alice, 'PUT', `/projects/${s.pid}/graph`, next);
      expect(put.body).toEqual({ version: 2, role: 'owner' });
      const g = (await api(alice, 'GET', `/projects/${s.pid}/graph`)).body as GraphResponse;
      expect(g.doc.tasks.map((t) => t.rev)).toEqual([2, 2]);
      const ch = (await api(alice, 'GET', `/projects/${s.pid}/changes?since=1`)).body as ChangesResponse;
      expect(ch.deletedTaskIds).toEqual([s.c.id]);
      expect(ch.deletedDepIds).toEqual([s.dab.id]);
    });

    it('editor の patch は成功し rev が採番される', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      await addMember(api, alice, s.pid, bob, 'editor');
      const d: Task = makeTask({ id: newId(), name: 'D' });
      const patch = {
        ...emptyPatch(s.pid),
        upsertTasks: [
          { ...s.a, name: 'A2', baseRev: 1 },
          { ...d, baseRev: 0 },
        ],
      };
      const res = await api(bob, 'POST', `/projects/${s.pid}/patch`, patch);
      expect(res.status).toBe(200);
      const ok = res.body as PatchOkResponse;
      expect(ok).toEqual({ ok: true, version: 2, newRevs: { [s.a.id]: 2, [d.id]: 1 } });
      const g = (await api(bob, 'GET', `/projects/${s.pid}/graph`)).body as GraphResponse;
      const a = g.doc.tasks.find((t) => t.id === s.a.id);
      expect(a).toMatchObject({ name: 'A2', rev: 2, updatedBy: bob.email });
      expect(g.doc.tasks).toHaveLength(4);
      expect(g.doc.project.version).toBe(2);
    });

    it('同じ baseRev を持つ 2 人目は 409（serverRow 付き）で、何も適用されない', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      await addMember(api, alice, s.pid, bob, 'editor');
      const first = await api(bob, 'POST', `/projects/${s.pid}/patch`, {
        ...emptyPatch(s.pid),
        upsertTasks: [{ ...s.a, name: 'by-bob', baseRev: 1 }],
      });
      expect(first.status).toBe(200);

      const e = makeTask({ id: newId(), name: 'E' });
      const second = await api(alice, 'POST', `/projects/${s.pid}/patch`, {
        ...emptyPatch(s.pid),
        upsertTasks: [
          { ...s.a, name: 'by-alice', baseRev: 1 },
          { ...e, baseRev: 0 },
        ],
      });
      expect(second.status).toBe(409);
      const body = second.body as PatchConflictResponse;
      expect(body.ok).toBe(false);
      expect(body.conflicts).toHaveLength(1);
      expect(body.conflicts[0]).toMatchObject({ entity: 'task', id: s.a.id, baseRev: 1, serverRev: 2 });
      expect(body.conflicts[0]!.serverRow).toMatchObject({ name: 'by-bob', rev: 2 });
      const g = (await api(alice, 'GET', `/projects/${s.pid}/graph`)).body as GraphResponse;
      expect(g.doc.tasks.some((t) => t.id === e.id)).toBe(false);
      expect(g.doc.project.version).toBe(2);
    });

    it('衝突規則: 既存行への baseRev=0 / 削除済み行への baseRev>0 / rev 不一致の削除は衝突、存在しない行の削除は成功', async () => {
      const { api, alice } = setup();
      const s = await seedProject(api, alice);
      const url = `/projects/${s.pid}/patch`;
      const dupNew = await api(alice, 'POST', url, { ...emptyPatch(s.pid), upsertTasks: [{ ...s.a, baseRev: 0 }] });
      expect(dupNew.status).toBe(409);
      const delUnsynced = await api(alice, 'POST', url, { ...emptyPatch(s.pid), deleteTaskIds: [{ id: s.a.id, baseRev: 0 }] });
      expect(delUnsynced.status).toBe(409);
      const delStale = await api(alice, 'POST', url, { ...emptyPatch(s.pid), deleteTaskIds: [{ id: s.a.id, baseRev: 7 }] });
      expect(delStale.status).toBe(409);
      const ghost = makeTask({ id: newId() });
      const upGhost = await api(alice, 'POST', url, { ...emptyPatch(s.pid), upsertTasks: [{ ...ghost, baseRev: 3 }] });
      expect(upGhost.status).toBe(409);
      expect((upGhost.body as PatchConflictResponse).conflicts[0]).toMatchObject({ serverRev: 0, serverRow: null });
      const delGhost = await api(alice, 'POST', url, { ...emptyPatch(s.pid), deleteTaskIds: [{ id: ghost.id, baseRev: 3 }] });
      expect(delGhost.status).toBe(200);
      expect((delGhost.body as PatchOkResponse).version).toBe(1);
    });

    it('タスク削除は依存をカスケード削除し、墓標が changes に現れる', async () => {
      const { api, alice } = setup();
      const s = await seedProject(api, alice);
      const res = await api(alice, 'POST', `/projects/${s.pid}/patch`, {
        ...emptyPatch(s.pid),
        deleteTaskIds: [{ id: s.a.id, baseRev: 1 }],
      });
      expect(res.status).toBe(200);
      const g = (await api(alice, 'GET', `/projects/${s.pid}/graph`)).body as GraphResponse;
      expect(g.doc.tasks.map((t) => t.id).sort()).toEqual([s.b.id, s.c.id].sort());
      expect(g.doc.dependencies).toEqual([]);
      const ch = (await api(alice, 'GET', `/projects/${s.pid}/changes?since=1`)).body as ChangesResponse;
      expect(ch.version).toBe(2);
      expect(ch.deletedTaskIds).toEqual([s.a.id]);
      expect(ch.deletedDepIds).toEqual([s.dab.id]);
      expect(ch.tasks).toEqual([]);
    });

    it('changes?since は新しい行・メタだけを返し、不正な since は 400', async () => {
      const { api, alice } = setup();
      const s = await seedProject(api, alice);
      const upd = await api(alice, 'POST', `/projects/${s.pid}/patch`, {
        ...emptyPatch(s.pid),
        upsertTasks: [{ ...s.b, name: 'B2', baseRev: 1 }],
      });
      expect(upd.status).toBe(200);

      const since1 = (await api(alice, 'GET', `/projects/${s.pid}/changes?since=1`)).body as ChangesResponse;
      expect(since1.tasks.map((t) => t.id)).toEqual([s.b.id]);
      expect(since1.dependencies).toEqual([]);
      expect(since1.project).toBeUndefined();
      expect(since1.version).toBe(2);

      const since2 = (await api(alice, 'GET', `/projects/${s.pid}/changes?since=2`)).body as ChangesResponse;
      expect(since2).toEqual({ version: 2, tasks: [], dependencies: [], deletedTaskIds: [], deletedDepIds: [] });

      const since0 = (await api(alice, 'GET', `/projects/${s.pid}/changes?since=0`)).body as ChangesResponse;
      expect(since0.tasks).toHaveLength(3);
      expect(since0.project?.id).toBe(s.pid);
      expect(since0.calendars).toBeDefined();
      expect(since0.savedViews).toEqual([]);

      for (const q of ['', '?since=abc', '?since=-1', '?since=1.5']) {
        expect((await api(alice, 'GET', `/projects/${s.pid}/changes${q}`)).status).toBe(400);
      }
    });

    it('project / calendars / savedViews は後勝ちで更新され metaVersion が進む', async () => {
      const { api, alice } = setup();
      const s = await seedProject(api, alice);
      const res = await api(alice, 'POST', `/projects/${s.pid}/patch`, {
        ...emptyPatch(s.pid),
        project: { name: 'Renamed', id: 'ignored' },
      });
      expect(res.status).toBe(200);
      const ch = (await api(alice, 'GET', `/projects/${s.pid}/changes?since=1`)).body as ChangesResponse;
      expect(ch.project).toMatchObject({ id: s.pid, name: 'Renamed', version: 2 });
      const list = (await api(alice, 'GET', '/projects')).body as ProjectSummary[];
      expect(list[0]).toMatchObject({ name: 'Renamed', taskCount: 3, role: 'owner' });
    });

    it('並行編集で循環になる patch は 422 で何も適用されない', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      await addMember(api, alice, s.pid, bob, 'editor');
      // bob: b→c を追加（a→b→c）
      const bc = makeDep(s.b.id, s.c.id, { id: newId() });
      const ok = await api(bob, 'POST', `/projects/${s.pid}/patch`, { ...emptyPatch(s.pid), upsertDeps: [{ ...bc, baseRev: 0 }] });
      expect(ok.status).toBe(200);
      // alice（bob の変更を知らない）: c→a を追加 → 合成すると循環
      const ca = makeDep(s.c.id, s.a.id, { id: newId() });
      const res = await api(alice, 'POST', `/projects/${s.pid}/patch`, { ...emptyPatch(s.pid), upsertDeps: [{ ...ca, baseRev: 0 }] });
      expect(res.status).toBe(422);
      expect((res.body as { error: { code: string; details?: string[] } }).error.details?.length).toBeGreaterThan(0);
      const g = (await api(alice, 'GET', `/projects/${s.pid}/graph`)).body as GraphResponse;
      expect(g.doc.dependencies.map((d) => d.id).sort()).toEqual([s.dab.id, bc.id].sort());
      expect(g.doc.project.version).toBe(2);
    });

    it('削除済みタスクへの依存を追加する patch は 422', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      await addMember(api, alice, s.pid, bob, 'editor');
      await api(bob, 'POST', `/projects/${s.pid}/patch`, { ...emptyPatch(s.pid), deleteTaskIds: [{ id: s.c.id, baseRev: 1 }] });
      const bad = makeDep(s.b.id, s.c.id, { id: newId() });
      const res = await api(alice, 'POST', `/projects/${s.pid}/patch`, { ...emptyPatch(s.pid), upsertDeps: [{ ...bad, baseRev: 0 }] });
      expect(res.status).toBe(422);
    });

    it('不正な patch 形式・projectId 不一致・不正な行は 422', async () => {
      const { api, alice } = setup();
      const s = await seedProject(api, alice);
      expect((await api(alice, 'POST', `/projects/${s.pid}/patch`, { upsertTasks: 'x' })).status).toBe(422);
      expect((await api(alice, 'POST', `/projects/${s.pid}/patch`, { ...emptyPatch('other') })).status).toBe(422);
      const badTask = { ...s.a, durationDays: 'many', baseRev: 1 };
      expect((await api(alice, 'POST', `/projects/${s.pid}/patch`, { ...emptyPatch(s.pid), upsertTasks: [badTask] })).status).toBe(422);
    });

    it('viewState は個人ごとで、共有 version を進めない', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      await addMember(api, alice, s.pid, bob, 'editor');
      const res = await api(bob, 'POST', `/projects/${s.pid}/patch`, {
        ...emptyPatch(s.pid),
        viewState: { collapsedWbs: ['1'], expandLevel: 3 },
      });
      expect((res.body as PatchOkResponse).version).toBe(1);
      const bobG = (await api(bob, 'GET', `/projects/${s.pid}/graph`)).body as GraphResponse;
      const aliceG = (await api(alice, 'GET', `/projects/${s.pid}/graph`)).body as GraphResponse;
      expect(bobG.doc.viewState).toEqual({ collapsedWbs: ['1'], expandLevel: 3 });
      expect(aliceG.doc.viewState).toEqual(s.doc.viewState);
    });
  });

  describe('メンバー', () => {
    it('owner が email で招待すると、招待された人の一覧に role 付きで現れる', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      const res = await api(alice, 'PUT', `/projects/${s.pid}/members`, { email: `  ${bob.email.toUpperCase()} `, role: 'editor' });
      expect(res.status).toBe(200);
      const members = res.body as Member[];
      expect(members.map((m) => [m.email, m.role]).sort()).toEqual(
        [[alice.email, 'owner'], [bob.email, 'editor']].sort(),
      );
      expect(members.find((m) => m.email === bob.email)?.name).toBeNull();

      const list = (await api(bob, 'GET', '/projects')).body as ProjectSummary[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: s.pid, role: 'editor' });

      const after = (await api(alice, 'GET', `/projects/${s.pid}/members`)).body as Member[];
      expect(after.find((m) => m.email === bob.email)?.name).toBe(bob.name);
    });

    it('role 変更・削除ができ、不正な入力は 422、存在しない削除は 404', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      await addMember(api, alice, s.pid, bob, 'viewer');
      await addMember(api, alice, s.pid, bob, 'editor');
      const list = (await api(alice, 'GET', `/projects/${s.pid}/members`)).body as Member[];
      expect(list.find((m) => m.email === bob.email)?.role).toBe('editor');
      expect((await api(alice, 'PUT', `/projects/${s.pid}/members`, { email: 'not-an-email', role: 'viewer' })).status).toBe(422);
      expect((await api(alice, 'PUT', `/projects/${s.pid}/members`, { email: 'x@example.com', role: 'admin' })).status).toBe(422);
      const del = await api(alice, 'DELETE', `/projects/${s.pid}/members/${encodeURIComponent(bob.email)}`);
      expect(del.status).toBe(200);
      expect((del.body as Member[]).map((m) => m.email)).toEqual([alice.email]);
      expect((await api(bob, 'GET', `/projects/${s.pid}/graph`)).status).toBe(404);
      expect((await api(alice, 'DELETE', `/projects/${s.pid}/members/${encodeURIComponent(bob.email)}`)).status).toBe(404);
    });

    it('最後の owner は降格も削除もできない', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      expect((await api(alice, 'PUT', `/projects/${s.pid}/members`, { email: alice.email, role: 'editor' })).status).toBe(422);
      expect((await api(alice, 'DELETE', `/projects/${s.pid}/members/${encodeURIComponent(alice.email)}`)).status).toBe(422);
      await addMember(api, alice, s.pid, bob, 'owner');
      expect((await api(alice, 'PUT', `/projects/${s.pid}/members`, { email: alice.email, role: 'editor' })).status).toBe(200);
      // 今度は bob が唯一の owner
      expect((await api(bob, 'DELETE', `/projects/${s.pid}/members/${encodeURIComponent(bob.email)}`)).status).toBe(422);
    });
  });

  describe('プロジェクト操作', () => {
    it('duplicate は呼び出し者のみを owner とする新規プロジェクトを作る', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      await addMember(api, alice, s.pid, bob, 'viewer');
      const res = await api(bob, 'POST', `/projects/${s.pid}/duplicate`, { newName: 'Copy' });
      expect(res.status).toBe(200);
      const g = res.body as GraphResponse;
      expect(g.role).toBe('owner');
      expect(g.doc.project).toMatchObject({ name: 'Copy', version: 1 });
      expect(g.doc.project.id).not.toBe(s.pid);
      expect(g.doc.tasks).toHaveLength(3);
      expect(g.doc.tasks.every((t) => t.rev === 1 && !s.doc.tasks.some((o) => o.id === t.id))).toBe(true);
      expect(g.doc.dependencies).toHaveLength(1);

      const members = (await api(bob, 'GET', `/projects/${g.doc.project.id}/members`)).body as Member[];
      expect(members.map((m) => [m.email, m.role])).toEqual([[bob.email, 'owner']]);
      expect(((await api(bob, 'GET', '/projects')).body as ProjectSummary[]).map((p) => p.role).sort()).toEqual(['owner', 'viewer']);
      expect((await api(alice, 'GET', `/projects/${g.doc.project.id}/graph`)).status).toBe(404);
      expect((await api(bob, 'POST', `/projects/${s.pid}/duplicate`, {})).status).toBe(422);
    });

    it('owner のみ削除でき、以後は 404', async () => {
      const { api, alice, bob } = setup();
      const s = await seedProject(api, alice);
      await addMember(api, alice, s.pid, bob, 'editor');
      expect((await api(bob, 'DELETE', `/projects/${s.pid}`)).status).toBe(403);
      const del = await api(alice, 'DELETE', `/projects/${s.pid}`);
      expect(del.status).toBe(204);
      expect(del.body).toBeUndefined();
      expect((await api(alice, 'GET', `/projects/${s.pid}/graph`)).status).toBe(404);
      expect((await api(alice, 'GET', '/projects')).body).toEqual([]);
      expect((await api(bob, 'GET', '/projects')).body).toEqual([]);
    });

    it('スナップショット一覧と restore（pre-restore を残して全量置換）', async () => {
      const { api, alice } = setup();
      const s = await seedProject(api, alice);
      const first = (await api(alice, 'GET', `/projects/${s.pid}/snapshots`)).body as SnapshotMeta[];
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ projectId: s.pid, label: 'saveGraph', taskCount: 3 });

      const smaller: GraphDoc = { ...s.doc, tasks: [s.a, s.b], dependencies: [] };
      expect((await api(alice, 'PUT', `/projects/${s.pid}/graph`, smaller)).status).toBe(200);
      const two = (await api(alice, 'GET', `/projects/${s.pid}/snapshots`)).body as SnapshotMeta[];
      expect(two.map((m) => m.taskCount)).toEqual([2, 3]); // 新しい順

      const res = await api(alice, 'POST', `/projects/${s.pid}/snapshots/${two[1]!.seq}/restore`);
      expect(res.status).toBe(200);
      const g = res.body as GraphResponse;
      expect(g.doc.tasks).toHaveLength(3);
      expect(g.doc.dependencies).toHaveLength(1);
      expect(g.doc.project.version).toBe(3);
      const labels = ((await api(alice, 'GET', `/projects/${s.pid}/snapshots`)).body as SnapshotMeta[]).map((m) => m.label);
      expect(labels).toContain('pre-restore');
      expect((await api(alice, 'POST', `/projects/${s.pid}/snapshots/999999/restore`)).status).toBe(404);
      expect((await api(alice, 'POST', `/projects/${s.pid}/snapshots/abc/restore`)).status).toBe(400);
    });
  });

  describe('ルーティング', () => {
    it('未定義パスは 404、メソッド違いは 405', async () => {
      const { api, alice } = setup();
      expect((await api(alice, 'GET', '/nope')).status).toBe(404);
      expect((await api(alice, 'POST', '/me')).status).toBe(405);
    });
  });
}
