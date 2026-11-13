// ============================================================================
// 永続化ブリッジ（§6.1）: store のダーティ集合 → GraphPatch を組み立て、
// DexieRepository.savePatch（差分書き）へ渡す。localStorage 全量保存を置き換える。
// ・複数プロジェクト: 現在プロジェクトIDは localStorage に軽く保持（本体は Dexie）。
// ・store を import しない（循環回避）。状態は引数で受け取る stateless モジュール。
// ============================================================================
import type { GraphDoc } from '../domain';
import { getRepository } from '../storage/DexieRepository';
import { getApiRepository } from '../storage/ApiRepository';
import { API_MODE } from '../storage/mode';
import type { GraphPatch, GraphRepository, PatchResult } from '../storage/GraphRepository';
import { buildApiPatch, commitPatch, isPatchEmpty, syncState } from './sync';

export interface DirtySnapshot {
  tasks: string[];
  deps: string[];
  deletedTasks: string[];
  deletedDeps: string[];
}

// サーバー版（VITE_STORAGE=api）ではビルド時定数により Dexie 側は使われない。
const repo: GraphRepository = API_MODE ? getApiRepository() : getRepository();
const CUR_KEY = 'epc-current-project';

export function getRepo(): GraphRepository {
  return repo;
}

export function getCurrentProjectId(): string | null {
  try {
    return localStorage.getItem(CUR_KEY);
  } catch {
    return null;
  }
}
export function setCurrentProjectId(id: string): void {
  try {
    localStorage.setItem(CUR_KEY, id);
  } catch {
    /* ignore */
  }
}

// ダーティ集合と現在 doc から差分パッチを組む。baseRev=0（ローカル単独運用は衝突なし・§7.2）。
export function buildPatch(doc: GraphDoc, dirty: DirtySnapshot): GraphPatch {
  const taskById = new Map(doc.tasks.map((t) => [t.id, t]));
  const depById = new Map(doc.dependencies.map((d) => [d.id, d]));
  const deletedTasks = new Set(dirty.deletedTasks);
  const deletedDeps = new Set(dirty.deletedDeps);

  const upsertTasks = dirty.tasks
    .filter((id) => !deletedTasks.has(id) && taskById.has(id))
    .map((id) => ({ ...taskById.get(id)!, baseRev: 0 }));
  const upsertDeps = dirty.deps
    .filter((id) => !deletedDeps.has(id) && depById.has(id))
    .map((id) => ({ ...depById.get(id)!, baseRev: 0 }));

  return {
    projectId: doc.project.id,
    baseProjectVersion: doc.project.version,
    upsertTasks,
    deleteTaskIds: dirty.deletedTasks.map((id) => ({ id, baseRev: 0 })),
    upsertDeps,
    deleteDepIds: dirty.deletedDeps.map((id) => ({ id, baseRev: 0 })),
    project: {
      name: doc.project.name,
      description: doc.project.description,
      dataDate: doc.project.dataDate,
      calendarId: doc.project.calendarId,
    },
    viewState: doc.viewState,
    savedViews: doc.savedViews,
    calendars: doc.calendars,
  };
}

export async function persistPatch(doc: GraphDoc, dirty: DirtySnapshot): Promise<PatchResult> {
  if (!API_MODE) return repo.savePatch(buildPatch(doc, dirty));
  const epoch = syncState.epoch;
  const patch = buildApiPatch(doc, dirty, syncState);
  // 変更がなければサーバーへ送らない（ポーリング間の空保存を避ける）。
  if (isPatchEmpty(patch)) return { ok: true, version: syncState.lastVersion, newRevs: {} };
  const result = await repo.savePatch(patch);
  // 保存中にプロジェクトが切り替わっていたら、新しい同期状態を汚さない。
  if (result.ok && syncState.epoch === epoch) commitPatch(syncState, patch, result.newRevs);
  return result;
}
