import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { emptyDoc, makeTask, MAX_DAYS } from "../../src/domain";
const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
  duplicate: vi.fn(),
  list: vi.fn(),
}));
vi.mock("../../src/store/persistence", () => ({
  getRepo: () => ({
    saveGraph: mocks.save,
    loadGraph: mocks.load,
    duplicateProject: mocks.duplicate,
    listProjects: mocks.list,
  }),
  getCurrentProjectId: () => null,
  setCurrentProjectId: vi.fn(),
  persistPatch: mocks.patch,
}));
vi.mock("../../src/layout/layout", () => ({
  runFullLayout: vi.fn(async () => ({})),
}));
import { useApp, flushPersistence } from "../../src/store/store";
function dirtyEmpty() {
  return {
    tasks: new Set<string>(),
    deps: new Set<string>(),
    deletedTasks: new Set<string>(),
    deletedDeps: new Set<string>(),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.patch.mockReset().mockResolvedValue({ ok: true });
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.load.mockReset();
  mocks.duplicate.mockReset();
  useApp.getState().loadDoc(emptyDoc("test"), { persist: false });
  useApp.setState({ dirty: dirtyEmpty(), saveStatus: "saved" });
});
afterEach(async () => {
  await flushPersistence().catch(() => {});
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe("Persistence across product workflows", () => {
  it("deleting a task also persists the deletion of its dependencies", async () => {
    const a = useApp.getState().addTask({ name: "a" });
    const b = useApp.getState().addTask({ name: "b" });
    expect(useApp.getState().addDependencyChecked(a.id, b.id)).toBe(true);
    const depId = useApp.getState().dependencies[0].id;
    await flushPersistence();
    useApp.getState().deleteTasks([a.id]);
    await flushPersistence();
    expect(mocks.patch.mock.lastCall![1].deletedDeps).toContain(depId);
  });
  it("undoing an unsaved deletion restores the task in the persisted patch", async () => {
    const t = useApp.getState().addTask({ name: "kept" });
    await flushPersistence();
    useApp.getState().deleteTasks([t.id]);
    useApp.getState().undo();
    await flushPersistence();
    const [doc, dirty] = mocks.patch.mock.lastCall!;
    expect(doc.tasks.some((x: { id: string }) => x.id === t.id)).toBe(true);
    expect(dirty.tasks).toContain(t.id);
    expect(dirty.deletedTasks).not.toContain(t.id);
  });
  it("undoing a task creation removes its persisted row; redo restores it", async () => {
    const t = useApp.getState().addTask({ name: "created" });
    await flushPersistence();
    useApp.getState().undo();
    await flushPersistence();
    expect(mocks.patch.mock.lastCall![1].deletedTasks).toContain(t.id);
    useApp.getState().redo();
    await flushPersistence();
    expect(mocks.patch.mock.lastCall![1].tasks).toContain(t.id);
    expect(mocks.patch.mock.lastCall![1].deletedTasks).not.toContain(t.id);
  });
  it("undo marks only the rows that actually changed as dirty", async () => {
    const a = useApp.getState().addTask({ name: "a" });
    const b = useApp.getState().addTask({ name: "b" });
    await flushPersistence();
    useApp.getState().updateTask(a.id, { name: "a2" });
    await flushPersistence();
    useApp.getState().undo();
    await flushPersistence();
    const dirty = mocks.patch.mock.lastCall![1];
    expect(dirty.tasks).toEqual([a.id]);
    expect(dirty.tasks).not.toContain(b.id);
  });
  it("retains an edit to the same task made while saving", async () => {
    let finish!: (value: { ok: boolean }) => void;
    mocks.patch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const t = useApp.getState().addTask({ name: "first" });
    const saving = flushPersistence();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    useApp.getState().updateTask(t.id, { name: "latest" });
    finish({ ok: true });
    await saving;
    expect(mocks.patch).toHaveBeenCalledTimes(2);
    expect(mocks.patch.mock.lastCall![0].tasks[0].name).toBe("latest");
    expect(useApp.getState().saveStatus).toBe("saved");
  });
  it("persists a saved view created while an imported document is saving", async () => {
    let finish!: () => void;
    mocks.save.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    const doc = emptyDoc("imported");
    doc.tasks = [makeTask({ name: "imported task" })];
    useApp.getState().loadDoc(doc);
    const saving = flushPersistence();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    useApp.getState().saveCurrentView("工種別");
    finish();
    await saving;
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch.mock.lastCall![0].savedViews).toEqual([
      expect.objectContaining({ name: "工種別" }),
    ]);
    expect(useApp.getState().saveStatus).toBe("saved");
  });
  it("retries the entire imported document after a full save fails", async () => {
    mocks.save.mockRejectedValueOnce(new Error("quota"));
    const doc = emptyDoc("imported");
    doc.tasks = [makeTask({ name: "first" }), makeTask({ name: "second" })];
    useApp.getState().loadDoc(doc);
    await flushPersistence().catch(() => undefined);
    expect(useApp.getState().saveStatus).toBe("error");

    useApp.getState().updateTask(doc.tasks[0].id, { name: "edited" });
    await flushPersistence();
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.lastCall![0].tasks.map((t: { name: string }) => t.name))
      .toEqual(["edited", "second"]);
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(useApp.getState().saveStatus).toBe("saved");
  });
  it.each([true, false])("saves a replacement import queued during a full save (same project: %s)", async (sameProject) => {
    let finish!: () => void;
    mocks.save.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    const first = emptyDoc("first import");
    first.tasks = [makeTask({ name: "removed by replacement" })];
    useApp.getState().loadDoc(first);
    const saving = flushPersistence();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(mocks.save).toHaveBeenCalledTimes(1);

    const replacement = emptyDoc("replacement");
    if (sameProject) replacement.project.id = first.project.id;
    replacement.tasks = [makeTask({ name: "replacement task" })];
    useApp.getState().loadDoc(replacement);
    finish();
    await saving;

    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.lastCall![0]).toEqual(replacement);
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(useApp.getState().saveStatus).toBe("saved");
  });
  it("saves metadata-only changes before switching projects", async () => {
    const current = useApp.getState().project.id,
      target = emptyDoc("next");
    mocks.load.mockResolvedValue(target);
    useApp.getState().renameProject("renamed");
    await useApp.getState().switchProject(target.project.id);
    expect(mocks.patch.mock.lastCall![0].project).toMatchObject({
      id: current,
      name: "renamed",
    });
    expect(useApp.getState().project.id).toBe(target.project.id);
  });
  it("keeps the current document when its save fails during a project switch", async () => {
    const current = useApp.getState().project.id;
    mocks.patch.mockRejectedValueOnce(new Error("quota"));
    mocks.load.mockResolvedValue(emptyDoc("next"));
    useApp.getState().addTask({ name: "unsaved" });
    await useApp.getState().switchProject("next");
    expect(useApp.getState().project.id).toBe(current);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(useApp.getState().saveStatus).toBe("error");
  });
  it("flushes current changes before creating another project", async () => {
    const t = useApp.getState().addTask({ name: "latest" });
    await useApp.getState().newProject("second");
    expect(
      mocks.patch.mock.lastCall![0].tasks.map((x: { id: string }) => x.id),
    ).toContain(t.id);
    expect(useApp.getState().project.name).toBe("second");
  });
  it("bulk completion stays consistent with the progress indicator", () => {
    const t = makeTask({ progress: 35, status: "IN_PROGRESS" }),
      doc = emptyDoc();
    doc.tasks = [t];
    useApp.getState().loadDoc(doc, { persist: false });
    useApp.getState().bulkUpdateTasks([t.id], { status: "DONE" });
    expect(useApp.getState().tasks[0].progress).toBe(100);
  });
  it("does not create dependencies to deleted tasks and clears a stale connect source", () => {
    const a = makeTask({ name: "a" }),
      b = makeTask({ name: "b" }),
      doc = emptyDoc();
    doc.tasks = [a, b];
    useApp.getState().loadDoc(doc, { persist: false });
    useApp.getState().toggleConnectMode();
    useApp.getState().connectClick(a.id);
    expect(useApp.getState().connectSource).toBe(a.id);
    useApp.getState().deleteTasks([a.id]);
    expect(useApp.getState().connectSource).toBeNull();
    expect(useApp.getState().addDependencyChecked(a.id, b.id)).toBe(false);
    expect(useApp.getState().dependencies).toHaveLength(0);
  });
  it("clamps durationDays and lagDays to MAX_DAYS at the store boundary", () => {
    const a = makeTask({ name: "a" }),
      b = makeTask({ name: "b" }),
      doc = emptyDoc();
    doc.tasks = [a, b];
    useApp.getState().loadDoc(doc, { persist: false });
    useApp.getState().updateTask(a.id, { durationDays: 9999999 });
    expect(useApp.getState().tasks[0].durationDays).toBe(MAX_DAYS);
    expect(useApp.getState().addDependencyChecked(a.id, b.id)).toBe(true);
    const depId = useApp.getState().dependencies[0].id;
    useApp.getState().updateDep(depId, { lagDays: -9999999 });
    expect(useApp.getState().dependencies[0].lagDays).toBe(-MAX_DAYS);
    useApp.getState().updateDep(depId, { lagDays: Number.NaN });
    expect(useApp.getState().dependencies[0].lagDays).toBe(0);
  });
});
