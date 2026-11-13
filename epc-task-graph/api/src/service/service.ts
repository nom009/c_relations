import type { GraphDoc, ProjectMeta, ViewState } from '../domain';
import { cloneDocWithNewIds, nowISO, selectSnapshotsToKeep, validateSemantics } from '../domain';
import type { Dependency, Task } from '../domain';
import type {
  ChangesResponse,
  GraphResponse,
  MeResponse,
  Member,
  PatchConflict,
  PatchConflictResponse,
  PatchOkResponse,
  ProjectRole,
  ProjectSummary,
  SaveGraphResponse,
  SnapshotMeta,
} from '../contract';
import type { Principal } from '../auth/principal';
import { DuplicateKeyError, HttpError, badRequest, forbidden, invalid, notFound } from '../errors';
import type { MemberRow, ProjectRecord, ServerStore, Tx } from '../store/types';
import { MAX_ID_LEN, isRole, normalizeEmail, parsePatch, prepareDoc } from './validation';

const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };
const DEFAULT_VIEW_STATE: ViewState = { collapsedWbs: [], expandLevel: 2 };
const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

const toMeta = (r: ProjectRecord): ProjectMeta => ({
  id: r.id,
  name: r.name,
  description: r.description,
  calendarId: r.calendarId,
  dataDate: r.dataDate,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  version: r.version,
});

const buildDoc = (r: ProjectRecord, tasks: Task[], deps: Dependency[], viewState: ViewState): GraphDoc => ({
  schemaVersion: r.schemaVersion,
  project: toMeta(r),
  viewState,
  savedViews: r.savedViews,
  calendars: r.calendars,
  tasks,
  dependencies: deps,
});

const toMember = (m: MemberRow): Member => ({ email: m.email, role: m.role, name: m.name, addedAt: m.addedAt });

// 非メンバー・存在しないプロジェクトはどちらも 404（存在の有無を漏らさない）。
async function access(
  tx: Tx,
  id: string,
  user: Principal,
  need: ProjectRole,
  lock: boolean,
): Promise<{ project: ProjectRecord; role: ProjectRole }> {
  if (!id || id.length > MAX_ID_LEN) throw notFound('プロジェクト');
  const project = await tx.getProject(id, lock);
  if (!project) throw notFound('プロジェクト');
  const member = await tx.getMember(id, user.email);
  if (!member) throw notFound('プロジェクト');
  // 初回アクセス（招待後）やプロフィール変更時に userId/name を記録する。
  if (member.userId !== user.userId || member.name !== user.name) {
    await tx.setMemberIdentity(id, user.email, user.userId, user.name);
  }
  if (ROLE_RANK[member.role] < ROLE_RANK[need]) throw forbidden();
  return { project, role: member.role };
}

async function loadDoc(tx: Tx, project: ProjectRecord, user: Principal): Promise<GraphDoc> {
  // 同一トランザクション（単一接続）では並行発行せず順番に読む。
  const tasks = await tx.listTasks(project.id);
  const deps = await tx.listDeps(project.id);
  const vs = await tx.getViewState(project.id, user.userId);
  return buildDoc(project, tasks, deps, vs ?? DEFAULT_VIEW_STATE);
}

async function takeSnapshot(tx: Tx, doc: GraphDoc, label: string, now: string): Promise<void> {
  const id = doc.project.id;
  await tx.insertSnapshot(id, {
    createdAt: now,
    label,
    taskCount: doc.tasks.length,
    doc: { ...doc, viewState: DEFAULT_VIEW_STATE }, // viewState は個人のものなので履歴には含めない
  });
  const metas = await tx.listSnapshots(id);
  const keep = selectSnapshotsToKeep(metas);
  const drop = metas.filter((m) => !keep.has(m.seq)).map((m) => m.seq);
  if (drop.length) await tx.deleteSnapshots(id, drop);
}

// 全量置換（PUT graph / restore / duplicate 共通）。全行を rev = 旧rev+1 で書き直し、消えた行は墓標にする。
async function writeFullDoc(
  tx: Tx,
  existing: ProjectRecord | null,
  doc: GraphDoc,
  user: Principal,
  version: number,
  now: string,
  old?: { tasks: Task[]; deps: Dependency[] },
): Promise<{ record: ProjectRecord; tasks: Task[]; deps: Dependency[] }> {
  const id = doc.project.id;
  const record: ProjectRecord = {
    id,
    name: doc.project.name,
    description: doc.project.description,
    dataDate: doc.project.dataDate,
    calendarId: doc.project.calendarId,
    schemaVersion: doc.schemaVersion,
    version,
    metaVersion: version,
    calendars: doc.calendars,
    savedViews: doc.savedViews,
    createdAt: existing?.createdAt ?? doc.project.createdAt,
    updatedAt: now,
    updatedBy: user.email,
  };
  if (existing) await tx.updateProject(record);
  else await tx.insertProject(record);

  const oldTasks = old?.tasks ?? (existing ? await tx.listTasks(id) : []);
  const oldDeps = old?.deps ?? (existing ? await tx.listDeps(id) : []);
  const oldTaskRev = new Map(oldTasks.map((t) => [t.id, t.rev]));
  const oldDepRev = new Map(oldDeps.map((d) => [d.id, d.rev]));
  const tasks = doc.tasks.map((t) => ({ ...t, rev: (oldTaskRev.get(t.id) ?? 0) + 1, updatedBy: user.email }));
  const deps = doc.dependencies.map((d) => ({ ...d, rev: (oldDepRev.get(d.id) ?? 0) + 1, updatedBy: user.email }));

  const newTaskIds = new Set(tasks.map((t) => t.id));
  const newDepIds = new Set(deps.map((d) => d.id));
  const goneTasks = oldTasks.filter((t) => !newTaskIds.has(t.id)).map((t) => t.id);
  const goneDeps = oldDeps.filter((d) => !newDepIds.has(d.id)).map((d) => d.id);
  if (goneDeps.length) await tx.deleteRows(id, 'dep', goneDeps, version);
  if (goneTasks.length) await tx.deleteRows(id, 'task', goneTasks, version);
  if (tasks.length) await tx.putTasks(id, tasks, version);
  if (deps.length) await tx.putDeps(id, deps, version);
  return { record, tasks, deps };
}

const duplicateKeyToConflict = (e: unknown): never => {
  if (e instanceof DuplicateKeyError) throw new HttpError(409, 'conflict', '同じ ID のプロジェクトが同時に作成されました');
  throw e;
};

// ---------------------------------------------------------------- me / projects

export function me(user: Principal): MeResponse {
  return { userId: user.userId, email: user.email, name: user.name };
}

export function listProjects(store: ServerStore, user: Principal): Promise<ProjectSummary[]> {
  return store.transaction(async (tx) => {
    await tx.recordIdentity(user.email, user.userId, user.name);
    const items = await tx.listProjectsFor(user.email);
    return items.map((i) => ({ ...toMeta(i.record), role: i.role, taskCount: i.taskCount }));
  });
}

export function getGraph(store: ServerStore, user: Principal, id: string): Promise<GraphResponse> {
  return store.transaction(async (tx) => {
    const { project, role } = await access(tx, id, user, 'viewer', false);
    return { doc: await loadDoc(tx, project, user), role };
  });
}

export async function saveGraph(
  store: ServerStore,
  user: Principal,
  id: string,
  body: unknown,
): Promise<SaveGraphResponse> {
  const doc = prepareDoc(body);
  if (doc.project.id !== id) throw invalid('project.id がパスの ID と一致しません');
  try {
    return await store.transaction(async (tx) => {
      const now = nowISO();
      const existing = await tx.getProject(id, true);
      let role: ProjectRole = 'owner';
      if (existing) role = (await access(tx, id, user, 'editor', true)).role;
      const version = existing ? existing.version + 1 : 1;
      const { record, tasks, deps } = await writeFullDoc(tx, existing, doc, user, version, now);
      if (!existing) {
        await tx.insertMember(id, {
          email: user.email,
          role: 'owner',
          userId: user.userId,
          name: user.name,
          addedAt: now,
          addedBy: user.email,
        });
      }
      await tx.setViewState(id, user.userId, doc.viewState);
      await takeSnapshot(tx, buildDoc(record, tasks, deps, DEFAULT_VIEW_STATE), 'saveGraph', now);
      return { version, role };
    });
  } catch (e) {
    return duplicateKeyToConflict(e);
  }
}

// ---------------------------------------------------------------- patch / changes

export type PatchResponse = PatchOkResponse | PatchConflictResponse;

/*
 * 衝突規則（§7.2 L1）。パッチ全体を all-or-nothing で判定する。
 *  upsert: 行が存在 → baseRev === 現rev のときのみ可（baseRev=0 は「新規作成のつもり」なので既存行とは衝突）。
 *          行が存在しない → baseRev=0（新規）のみ可。baseRev>0 は他者に削除された＝衝突（serverRev=0, serverRow=null）。
 *  delete: 行が存在しない → 既に削除済みなので成功扱い（冪等・no-op）。
 *          行が存在 → baseRev === 現rev のときのみ可。baseRev=0（クライアントが未同期の行）や rev 不一致は衝突。
 */
export function applyPatch(store: ServerStore, user: Principal, id: string, body: unknown): Promise<PatchResponse> {
  const patch = parsePatch(body);
  if (patch.projectId !== undefined && patch.projectId !== id) throw invalid('projectId がパスの ID と一致しません');

  return store.transaction(async (tx): Promise<PatchResponse> => {
    const { project } = await access(tx, id, user, 'editor', true);
    const taskMap = new Map((await tx.listTasks(id)).map((t) => [t.id, t]));
    const depMap = new Map((await tx.listDeps(id)).map((d) => [d.id, d]));

    const conflicts: PatchConflict[] = [];
    const check = (
      entity: 'task' | 'dep',
      rowId: string,
      baseRev: number,
      cur: Task | Dependency | undefined,
      isDelete: boolean,
    ): void => {
      if (cur) {
        if (baseRev === 0 || cur.rev !== baseRev) conflicts.push({ entity, id: rowId, baseRev, serverRev: cur.rev, serverRow: cur });
      } else if (!isDelete && baseRev > 0) {
        conflicts.push({ entity, id: rowId, baseRev, serverRev: 0, serverRow: null });
      }
    };
    for (const u of patch.upsertTasks) check('task', u.row.id, u.baseRev, taskMap.get(u.row.id), false);
    for (const d of patch.deleteTaskIds) check('task', d.id, d.baseRev, taskMap.get(d.id), true);
    for (const u of patch.upsertDeps) check('dep', u.row.id, u.baseRev, depMap.get(u.row.id), false);
    for (const d of patch.deleteDepIds) check('dep', d.id, d.baseRev, depMap.get(d.id), true);
    if (conflicts.length) return { ok: false, conflicts };

    const now = nowISO();
    const newRevs: Record<string, number> = {};

    // 削除（存在する行のみ）。タスク削除は、それを参照する依存もカスケード削除する。
    const delTaskIds = patch.deleteTaskIds.map((d) => d.id).filter((x) => taskMap.has(x));
    const delTaskSet = new Set(delTaskIds);
    const delDepSet = new Set(patch.deleteDepIds.map((d) => d.id).filter((x) => depMap.has(x)));
    for (const d of depMap.values()) {
      if (delTaskSet.has(d.predecessorId) || delTaskSet.has(d.successorId)) delDepSet.add(d.id);
    }
    const delDepIds = [...delDepSet];
    for (const x of delTaskIds) taskMap.delete(x);
    for (const x of delDepIds) depMap.delete(x);

    const putTasks = patch.upsertTasks.map(({ row }) => {
      const rev = (taskMap.get(row.id)?.rev ?? 0) + 1;
      newRevs[row.id] = rev;
      return { ...row, rev, updatedBy: user.email, updatedAt: now };
    });
    const putDeps = patch.upsertDeps.map(({ row }) => {
      const rev = (depMap.get(row.id)?.rev ?? 0) + 1;
      newRevs[row.id] = rev;
      return { ...row, rev, updatedBy: user.email, updatedAt: now };
    });
    for (const t of putTasks) taskMap.set(t.id, t);
    for (const d of putDeps) depMap.set(d.id, d);

    const metaChanged = !!(patch.project || patch.calendars || patch.savedViews);
    const sharedChanged =
      putTasks.length > 0 || putDeps.length > 0 || delTaskIds.length > 0 || delDepIds.length > 0 || metaChanged;

    if (patch.viewState) await tx.setViewState(id, user.userId, patch.viewState); // 個人用: version は進めない
    if (!sharedChanged) return { ok: true, version: project.version, newRevs };

    // 並行編集の合成結果（循環・削除済みタスクへの依存など）を検証。不正なら例外でロールバック。
    const merged = validateSemantics({ tasks: [...taskMap.values()], dependencies: [...depMap.values()] });
    if (!merged.ok) throw invalid('変更を適用すると整合性が壊れます', merged.errors.slice(0, 50));

    const version = project.version + 1;
    if (delDepIds.length) await tx.deleteRows(id, 'dep', delDepIds, version);
    if (delTaskIds.length) await tx.deleteRows(id, 'task', delTaskIds, version);
    if (putTasks.length) await tx.putTasks(id, putTasks, version);
    if (putDeps.length) await tx.putDeps(id, putDeps, version);

    const record: ProjectRecord = {
      ...project,
      ...(patch.project ?? {}),
      calendars: patch.calendars ?? project.calendars,
      savedViews: patch.savedViews ?? project.savedViews,
      version,
      metaVersion: metaChanged ? version : project.metaVersion,
      updatedAt: now,
      updatedBy: user.email,
    };
    await tx.updateProject(record);

    // 自動履歴: 直近の履歴から一定時間経っていれば全量スナップショット（失敗しても保存本体は妨げない）。
    try {
      const latest = (await tx.listSnapshots(id))[0];
      if (!latest || Date.parse(now) - Date.parse(latest.createdAt) >= AUTOSAVE_INTERVAL_MS) {
        const doc = buildDoc(record, [...taskMap.values()], [...depMap.values()], DEFAULT_VIEW_STATE);
        await takeSnapshot(tx, doc, 'autosave', now);
      }
    } catch (e) {
      console.error('[api] autosave snapshot failed', e);
    }
    return { ok: true, version, newRevs };
  });
}

export function getChanges(store: ServerStore, user: Principal, id: string, sinceRaw: string | undefined): Promise<ChangesResponse> {
  if (sinceRaw === undefined || !/^\d{1,10}$/.test(sinceRaw)) throw badRequest('since（0 以上の整数）が必要です');
  const since = Number(sinceRaw);
  return store.transaction(async (tx) => {
    const { project } = await access(tx, id, user, 'viewer', false);
    const ch = await tx.changesSince(id, since);
    const res: ChangesResponse = {
      version: project.version,
      tasks: ch.tasks,
      dependencies: ch.deps,
      deletedTaskIds: ch.deletedTaskIds,
      deletedDepIds: ch.deletedDepIds,
    };
    if (project.metaVersion > since) {
      res.project = toMeta(project);
      res.calendars = project.calendars;
      res.savedViews = project.savedViews;
    }
    return res;
  });
}

// ---------------------------------------------------------------- delete / duplicate / snapshots

export function deleteProject(store: ServerStore, user: Principal, id: string): Promise<void> {
  return store.transaction(async (tx) => {
    await access(tx, id, user, 'owner', true);
    await tx.deleteProject(id);
  });
}

export async function duplicateProject(
  store: ServerStore,
  user: Principal,
  id: string,
  body: unknown,
): Promise<GraphResponse> {
  const newName = (body as { newName?: unknown } | null | undefined)?.newName;
  if (typeof newName !== 'string' || !newName.trim()) throw invalid('newName が必要です');
  try {
    return await store.transaction(async (tx) => {
      const { project } = await access(tx, id, user, 'viewer', false);
      const src = await loadDoc(tx, project, user);
      const now = nowISO();
      const copy = cloneDocWithNewIds(src, newName.trim());
      const newId = copy.project.id;
      const { record, tasks, deps } = await writeFullDoc(tx, null, copy, user, 1, now);
      await tx.insertMember(newId, {
        email: user.email,
        role: 'owner',
        userId: user.userId,
        name: user.name,
        addedAt: now,
        addedBy: user.email,
      });
      await tx.setViewState(newId, user.userId, src.viewState);
      await takeSnapshot(tx, buildDoc(record, tasks, deps, DEFAULT_VIEW_STATE), 'saveGraph', now);
      return { doc: buildDoc(record, tasks, deps, src.viewState), role: 'owner' as const };
    });
  } catch (e) {
    return duplicateKeyToConflict(e);
  }
}

export function listSnapshots(store: ServerStore, user: Principal, id: string): Promise<SnapshotMeta[]> {
  return store.transaction(async (tx) => {
    await access(tx, id, user, 'viewer', false);
    return tx.listSnapshots(id);
  });
}

export function restoreSnapshot(
  store: ServerStore,
  user: Principal,
  id: string,
  seqRaw: string,
): Promise<GraphResponse> {
  if (!/^\d{1,10}$/.test(seqRaw)) throw badRequest('seq が不正です');
  const seq = Number(seqRaw);
  return store.transaction(async (tx) => {
    const { project, role } = await access(tx, id, user, 'editor', true);
    const snap = await tx.getSnapshot(id, seq);
    if (!snap) throw notFound('スナップショット');
    const restored = prepareDoc(snap.doc); // 壊れた履歴で現在のデータを上書きしない
    restored.project = { ...restored.project, id };

    const now = nowISO();
    const tasks = await tx.listTasks(id);
    const deps = await tx.listDeps(id);
    await takeSnapshot(tx, buildDoc(project, tasks, deps, DEFAULT_VIEW_STATE), 'pre-restore', now);

    const version = project.version + 1;
    const written = await writeFullDoc(tx, project, restored, user, version, now, { tasks, deps });
    const vs = (await tx.getViewState(id, user.userId)) ?? DEFAULT_VIEW_STATE;
    return { doc: buildDoc(written.record, written.tasks, written.deps, vs), role };
  });
}

// ---------------------------------------------------------------- members

async function ownerCount(tx: Tx, id: string): Promise<number> {
  return (await tx.listMembers(id)).filter((m) => m.role === 'owner').length;
}

const sortedMembers = async (tx: Tx, id: string): Promise<Member[]> =>
  (await tx.listMembers(id))
    .sort((a, b) => (a.addedAt === b.addedAt ? a.email.localeCompare(b.email) : a.addedAt.localeCompare(b.addedAt)))
    .map(toMember);

export function listMembers(store: ServerStore, user: Principal, id: string): Promise<Member[]> {
  return store.transaction(async (tx) => {
    await access(tx, id, user, 'viewer', false);
    return sortedMembers(tx, id);
  });
}

export function upsertMember(store: ServerStore, user: Principal, id: string, body: unknown): Promise<Member[]> {
  const b = (body ?? {}) as { email?: unknown; role?: unknown };
  const email = normalizeEmail(b.email);
  if (!isRole(b.role)) throw invalid('role は owner / editor / viewer のいずれかです');
  const role = b.role;
  return store.transaction(async (tx) => {
    await access(tx, id, user, 'owner', true);
    const cur = await tx.getMember(id, email);
    if (cur) {
      if (cur.role === 'owner' && role !== 'owner' && (await ownerCount(tx, id)) <= 1) {
        throw invalid('最後の owner は降格できません');
      }
      if (cur.role !== role) await tx.setMemberRole(id, email, role);
    } else {
      await tx.insertMember(id, { email, role, userId: null, name: null, addedAt: nowISO(), addedBy: user.email });
    }
    return sortedMembers(tx, id);
  });
}

export function removeMember(store: ServerStore, user: Principal, id: string, emailRaw: string): Promise<Member[]> {
  const email = emailRaw.trim().toLowerCase();
  return store.transaction(async (tx) => {
    await access(tx, id, user, 'owner', true);
    const cur = await tx.getMember(id, email);
    if (!cur) throw notFound('メンバー');
    if (cur.role === 'owner' && (await ownerCount(tx, id)) <= 1) throw invalid('最後の owner は削除できません');
    await tx.deleteMember(id, email);
    return sortedMembers(tx, id);
  });
}
