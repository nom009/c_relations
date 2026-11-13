import { describe, it, expect } from "vitest";
import { emptyDoc, makeDep, makeTask } from "../../src/domain";
import {
  adoptServerRevs,
  buildApiPatch,
  commitPatch,
  createSyncState,
  planRemoteChanges,
  resetSync,
} from "../../src/store/sync";
import type { DirtySnapshot } from "../../src/store/persistence";
import type { ChangesResponse } from "../../src/storage/apiContract";

const dirtyOf = (p: Partial<DirtySnapshot> = {}): DirtySnapshot => ({
  tasks: [],
  deps: [],
  deletedTasks: [],
  deletedDeps: [],
  ...p,
});

function syncedDoc() {
  const doc = emptyDoc("p");
  doc.tasks = [makeTask({ name: "A", rev: 3 }), makeTask({ name: "B", rev: 5 })];
  doc.dependencies = [makeDep(doc.tasks[0].id, doc.tasks[1].id, { rev: 2 })];
  const sync = createSyncState();
  resetSync(sync, doc);
  return { doc, sync };
}

const changes = (p: Partial<ChangesResponse>): ChangesResponse => ({
  version: 9,
  tasks: [],
  dependencies: [],
  deletedTaskIds: [],
  deletedDepIds: [],
  ...p,
});

describe("buildApiPatch（サーバー版）", () => {
  it("baseRev は同期済み rev から取り、未同期の新規行は 0", () => {
    const { doc, sync } = syncedDoc();
    const fresh = makeTask({ name: "new" });
    doc.tasks.push(fresh);
    const patch = buildApiPatch(
      doc,
      dirtyOf({
        tasks: [doc.tasks[0].id, fresh.id],
        deletedDeps: [doc.dependencies[0].id],
      }),
      sync,
    );
    expect(patch.upsertTasks.map((t) => [t.name, t.baseRev])).toEqual([
      ["A", 3],
      ["new", 0],
    ]);
    expect(patch.deleteDepIds).toEqual([{ id: doc.dependencies[0].id, baseRev: 2 }]);
  });

  it("project/calendars/savedViews/viewState は変更があった時だけ含め、成功後は再送しない", () => {
    const { doc, sync } = syncedDoc();
    const none = buildApiPatch(doc, dirtyOf(), sync);
    expect(none.project).toBeUndefined();
    expect(none.calendars).toBeUndefined();
    expect(none.savedViews).toBeUndefined();
    expect(none.viewState).toBeUndefined();

    doc.project = { ...doc.project, name: "renamed" };
    const patch = buildApiPatch(doc, dirtyOf(), sync);
    expect(patch.project?.name).toBe("renamed");
    expect(patch.calendars).toBeUndefined();

    commitPatch(sync, patch, {});
    expect(buildApiPatch(doc, dirtyOf(), sync).project).toBeUndefined();
  });

  it("成功後は newRevs で rev を更新し、「自分の変更で上書き」は serverRev を baseRev にする", () => {
    const { doc, sync } = syncedDoc();
    const id = doc.tasks[0].id;
    const patch = buildApiPatch(doc, dirtyOf({ tasks: [id] }), sync);
    commitPatch(sync, patch, { [id]: 4 });
    expect(sync.revs.get(id)).toBe(4);

    adoptServerRevs(sync, [
      { entity: "task", id, baseRev: 4, serverRev: 8, serverRow: makeTask({ id, rev: 8 }) },
    ]);
    expect(buildApiPatch(doc, dirtyOf({ tasks: [id] }), sync).upsertTasks[0].baseRev).toBe(8);
  });
});

describe("planRemoteChanges（ポーリングの取り込み）", () => {
  it("未保存で触っている行は取り込まず、他の行だけ取り込む", () => {
    const { doc, sync } = syncedDoc();
    const [a, b] = doc.tasks;
    const plan = planRemoteChanges(
      changes({
        tasks: [
          { ...a, name: "A-remote", rev: 4 },
          { ...b, name: "B-remote", rev: 6 },
        ],
      }),
      { ...doc },
      dirtyOf({ tasks: [a.id] }),
      sync,
    );
    expect(plan.upsertTasks.map((t) => t.name)).toEqual(["B-remote"]);
    expect(plan.revs).toEqual([[b.id, 6]]);
  });

  it("両者が削除した行は競合にせず、相手が削除し自分が触っていない行はストアから外す", () => {
    const { doc, sync } = syncedDoc();
    const [a, b] = doc.tasks;
    const plan = planRemoteChanges(
      changes({ deletedTaskIds: [a.id, b.id] }),
      { ...doc },
      dirtyOf({ deletedTasks: [a.id] }),
      sync,
    );
    expect(plan.settled.deletedTasks).toEqual([a.id]);
    expect(plan.removeTaskIds).toEqual([b.id]);
  });
});
