// ============================================================================
// 永続化ランタイム（store.ts から分割）: サーバー版フック（ApiHooks）の差し込み口・
// デバウンス差分保存（scheduleSave/flushPersistence）・起動時ハイドレート（bootstrapStore）。
// 状態を持たないブリッジ（DirtySnapshot→GraphPatch）は persistence.ts。
// useApp は関数本体の中でだけ参照する（モジュール評価時には触れない）。
// ============================================================================
import { NewerSchemaError, type GraphDoc } from "../domain";
import { CorruptDocError } from "../storage/GraphRepository";
import { backupReminderMessage, downloadJson, requestPersistentStorage } from "./backup";
import { isWriterTab } from "./writerLock";
import {
  getCurrentProjectId,
  getRepo,
  persistPatch,
  setCurrentProjectId,
  type DirtySnapshot,
} from "./persistence";
import { useApp } from "./store";
import type { ApiHooks, DirtyState } from "./storeTypes";
import { emptyDirty } from "./storeUtils";

let apiHooks: ApiHooks | null = null;
export function installApiHooks(hooks: ApiHooks | null): void {
  apiHooks = hooks;
}
export function getApiHooks(): ApiHooks | null {
  return apiHooks;
}
export function isFlushing(): boolean {
  return activeFlush !== null;
}

// ---- 永続化（Dexie・デバウンス500ms差分保存、§6.1）----
// ダーティ集合から GraphPatch を組み、DexieRepository.savePatch（差分書き）へ渡す。
// ハイドレーション中（起動時の Dexie 読込）は保存を抑止する。
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hydrating = false;

function snapshotDirty(d: DirtyState): DirtySnapshot {
  return {
    tasks: [...d.tasks],
    deps: [...d.deps],
    deletedTasks: [...d.deletedTasks],
    deletedDeps: [...d.deletedDeps],
  };
}

let saveGeneration = 0;
let writeQueue: Promise<unknown> = Promise.resolve();
let activeFlush: Promise<void> | null = null;
// Imports must keep retrying a full replacement until it succeeds.
let pendingFullSave: symbol | null = null;
export function enqueueWrite<T>(write: () => Promise<T>): Promise<T> {
  if (!isWriterTab()) return Promise.reject(new Error("別のタブが書き込み中です"));
  const result = writeQueue.then(write);
  writeQueue = result.catch(() => undefined);
  return result;
}

// Serialize writes; retain dirty rows if another edit happens during a save.
export function flushPersistence(): Promise<void> {
  if (!isWriterTab()) return Promise.resolve(); // 別タブが書込権を持つ間は書かない
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (activeFlush) return activeFlush;
  activeFlush = (async () => {
    await writeQueue;
    while (useApp.getState().saveStatus !== "saved") {
      const state = useApp.getState();
      const generation = saveGeneration;
      const doc = state.toDoc();
      const dirty = snapshotDirty(state.dirty);
      const fullSave = pendingFullSave;
      if (fullSave) {
        await enqueueWrite(() => getRepo().saveGraph(doc));
        if (pendingFullSave === fullSave) pendingFullSave = null;
        if (apiHooks) await apiHooks.afterFullSave(doc.project.id);
        if (useApp.getState().project.id === doc.project.id)
          setCurrentProjectId(doc.project.id);
        void useApp.getState().refreshProjects();
      } else {
        const result = await enqueueWrite(() => persistPatch(doc, dirty));
        if (!result.ok) {
          if (!apiHooks) throw new Error("保存の競合を検知しました");
          await apiHooks.resolveConflicts(result.conflicts);
          continue;
        }
      }
      if (useApp.getState().project.id !== doc.project.id) continue;
      if (generation === saveGeneration) {
        useApp.setState((s) => {
          s.dirty = emptyDirty();
          s.saveStatus = "saved";
        });
      }
    }
  })()
    .catch((error) => {
      if (apiHooks) return handleApiSaveError(apiHooks, error);
      useApp.setState({ saveStatus: "error" });
      useApp
        .getState()
        .showToast(
          "保存できませんでした。データを書き出して保管してください。",
          true,
        );
      throw error;
    })
    .finally(() => {
      activeFlush = null;
    });
  return activeFlush;
}
async function handleApiSaveError(hooks: ApiHooks, error: unknown): Promise<void> {
  if ((await hooks.onSaveError(error)) === "recovered") return;
  useApp.setState({ saveStatus: "error" });
  throw error;
}
export function scheduleSave(): void {
  if (useApp.getState().role === "viewer") return; // 閲覧のみは保存しない（個人の表示状態も端末内のみ）
  saveGeneration++;
  useApp.setState({ saveStatus: "dirty" });
  if (hydrating || !isWriterTab()) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushPersistence().catch(() => undefined);
  }, 500);
}

// ---- 全量差替え（loadDoc）・プロジェクト削除から使う保存状態の操作 ----
// 予約済みのデバウンス保存を取り消す。
export function clearSaveTimer(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}
// 保存世代を進める（進行中の保存が終わってもダーティ/保存済み表示を上書きしない）。
export function bumpSaveGeneration(): void {
  saveGeneration++;
}
export function isHydrating(): boolean {
  return hydrating;
}
// 全量保存（saveGraph）の予約。null で予約なし。
export function setPendingFullSave(token: symbol | null): void {
  pendingFullSave = token;
}
export function hasPendingFullSave(): boolean {
  return pendingFullSave !== null;
}

// 読込時に不整合（CorruptDocError）を検出したら、新しい履歴から順に復元を試みる。
// どれも使えなければ、ユーザーのデータを塞がないよう未検証のまま開いて警告する。
// 復元は現在のデータを上書きするため、直前の未検証データをファイルに退避してから行う。
// notified: 呼び出し側が他の通知（バックアップ促し等）を重ねる必要がないよう、トーストを出したか返す。
export async function loadGraphWithRecovery(id: string): Promise<{ doc: GraphDoc; notified: boolean }> {
  const repo = getRepo();
  try {
    return { doc: await repo.loadGraph(id), notified: false };
  } catch (err) {
    if (!(err instanceof CorruptDocError)) throw err;
    let saved = false;
    try {
      const snaps = await repo.listSnapshots(id);
      if (snaps.length) {
        try {
          downloadJson(err.doc, { recordBackup: false, suffix: "broken" });
          saved = true;
        } catch {
          /* 退避に失敗しても復元自体は続行する */
        }
      }
      for (const snap of snaps) {
        try {
          const doc = await repo.restoreSnapshot(id, snap.seq);
          useApp
            .getState()
            .showToast(
              `保存データの不整合を検出したため、${new Date(snap.createdAt).toLocaleString()}の履歴から復元しました` +
                (saved ? "（復元前のデータはファイルに保存しました）" : ""),
            );
          return { doc, notified: true };
        } catch {
          /* この履歴も使えない。次に新しい履歴へ */
        }
      }
    } catch {
      /* 履歴を読めない場合も未検証のデータで続行する */
    }
    useApp
      .getState()
      .showToast(
        `保存データに不整合があります（${err.errors[0] ?? "不明"}）。JSONエクスポートでバックアップしてください`,
        true,
      );
    return { doc: err.doc, notified: true };
  }
}

// 起動時: まず starter を同期表示 → Dexie から現在プロジェクトへ非同期ハイドレート（§6.1）。
// 空DBの初回は「現在の starter を初回プロジェクトとして保存」するだけで loadDoc しない
// （同期表示済みの state をクロバーしない）。既存プロジェクトがある時のみ読み込んで差し替える。
export async function bootstrapStore(): Promise<void> {
  hydrating = true;
  // サーバー版はサーバーが正本のため、永続ストレージ要求・バックアップ促しは行わない。
  const persistedReq: Promise<boolean | null> = apiHooks
    ? Promise.resolve(null)
    : requestPersistentStorage().then((persisted) => {
        useApp.setState({ storagePersisted: persisted });
        return persisted;
      });
  try {
    const repo = getRepo();
    const list = await repo.listProjects();
    if (!list.length) {
      const doc = useApp.getState().toDoc();
      await repo.saveGraph(doc);
      setCurrentProjectId(doc.project.id);
      if (apiHooks) await apiHooks.afterFullSave(doc.project.id, true);
    } else {
      const cur = getCurrentProjectId();
      const targetId = cur && list.some((p) => p.id === cur) ? cur : list[0].id;
      setCurrentProjectId(targetId);
      const { doc, notified } = await loadGraphWithRecovery(targetId);
      useApp.getState().loadDoc(doc, { persist: false });
      apiHooks?.adoptDoc(doc);
      // 永続化の結果は待たせずに起動し、判明後（遅くとも1.5秒後）にリマインドを判定する。
      if (!notified && !apiHooks)
        void Promise.race([
          persistedReq,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]).then((persisted) => {
          const reminder = backupReminderMessage(list, Date.now(), persisted);
          if (reminder) useApp.getState().showToast(reminder);
        });
    }
    await useApp.getState().refreshProjects();
  } catch (err) {
    useApp.setState({ saveStatus: "error" });
    useApp
      .getState()
      .showToast(
        err instanceof NewerSchemaError
          ? err.message
          : "保存領域を開けませんでした。ブラウザの設定を確認してください。",
        true,
      );
  } finally {
    hydrating = false;
    // 既定ビューが指定されていて現プロジェクトに実在すれば、起動直後に自動適用（実用化の入口）。
    // loadDoc が viewSpec を既定へ戻した後に適用するので順序が正しい。
    const st = useApp.getState();
    if (
      st.defaultViewId &&
      st.savedViews.some((v) => v.id === st.defaultViewId)
    ) {
      st.applyView(st.defaultViewId);
    }
    // ハイドレーション中に行われた編集（保存が抑止されていた分）を吐き出す。
    const d = useApp.getState().dirty;
    if (
      d.tasks.size ||
      d.deps.size ||
      d.deletedTasks.size ||
      d.deletedDeps.size
    )
      scheduleSave();
  }
}
