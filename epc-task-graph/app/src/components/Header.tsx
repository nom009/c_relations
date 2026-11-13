import { Icon } from "./workspace/Icon";
// ヘッダ/ツールバー（§1.3）: プロジェクト切替・CP強調・完了日・作成・整列・Undo/Redo・
//   デモ生成・Export/Import・保存状態。
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useApp, selectActiveCalendar, selectReadOnly, flushPersistence } from "../store/store";
import { API_MODE } from "../storage/mode";
import { selectCpm } from "../store/selectors";
import { downloadJson } from "../store/backup";
import { useSelectedTask } from "../store/hooks";
import { validateDoc, parseDoc, cloneDocWithNewIds, wbsPath, toMspdi, fromMspdi, emptyDoc, migrateDoc, repairDoc } from "../domain";

// データ入出力メニュー（ツールバー整理・§1.3）: JSON/MSPDI の出力・取込を1つのドロップダウンに集約。
function DataMenu({
  onJsonExport,
  onJsonImport,
  onMspdiExport,
  onMspdiImport,
}: {
  onJsonExport: () => void;
  onJsonImport: () => void;
  onMspdiExport: () => void;
  onMspdiImport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const item = (label: string, fn: () => void) => (
    <button
      className="menu-item"
      onClick={() => {
        fn();
        setOpen(false);
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="menu" ref={ref}>
      <button
        className="btn"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
        data-testid="data-menu"
        title="入出力"
      >
        データ ▾
      </button>
      {open ? (
        <div className="menu-pop">
          {item("JSONを書き出す", onJsonExport)}
          {item("JSONを読み込む…", onJsonImport)}
          <div className="menu-sep" />
          {item("MS Project XMLを書き出す", onMspdiExport)}
          {item("MS Project XMLを読み込む…", onMspdiImport)}
        </div>
      ) : null}
    </div>
  );
}

function ProjectBar() {
  const projectId = useApp((s) => s.project.id);
  const name = useApp((s) => s.project.name);
  const list = useApp((s) => s.projectList);
  return (
    <span className="projectbar">
      <select
        aria-label="プロジェクト切替"
        value={projectId}
        onChange={(e) => useApp.getState().switchProject(e.target.value)}
        title="プロジェクト切替"
      >
        {list.length === 0 ? <option value={projectId}>{name}</option> : null}
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id === projectId ? name : p.name}
          </option>
        ))}
      </select>
    </span>
  );
}

// 操作メニュー（二次操作を集約・大胆に隠す）: プロジェクト管理・整列・デモ生成。
function ActionsMenu({
  onNewProject,
  onSettings,
  onMembers,
}: {
  onNewProject?: () => void;
  onSettings?: () => void;
  onMembers?: () => void;
}) {
  const role = useApp((s) => s.role);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const item = (label: string, fn: () => void) => (
    <button
      className="menu-item"
      onClick={() => {
        fn();
        setOpen(false);
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="menu" ref={ref}>
      <button
        className="btn"
        aria-expanded={open}
        aria-haspopup="true"
        data-testid="actions-menu"
        title="操作"
        onClick={() => setOpen((o) => !o)}
      >
        操作 ▾
      </button>
      {open ? (
        <div className="menu-pop">
          {item("自動整列（表示中）", () =>
            useApp.getState().runners.layoutVisible?.(),
          )}
          {item("全体整列（Worker）", () => useApp.getState().layoutAll())}
          <div className="menu-sep" />
          {item("新規プロジェクト", () => onNewProject?.())}
          {item("プロジェクト設定", () => onSettings?.())}
          {API_MODE ? item("メンバー…", () => onMembers?.()) : null}
          {item("プロジェクトを複製", () =>
            useApp.getState().duplicateCurrentProject(),
          )}
          {!API_MODE || role === "owner"
            ? item("プロジェクトを削除…", () => {
                if (confirm("このプロジェクトを削除しますか？（元に戻せません）"))
                  useApp.getState().deleteCurrentProject();
              })
            : null}
          <div className="menu-sep" />
          {item("4,000ノード生成（デモ）", () =>
            useApp.getState().generateDemo(),
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Header({
  onNewProject,
  onSettings,
  onMembers,
}: {
  onNewProject?: () => void;
  onSettings?: () => void;
  onMembers?: () => void;
}) {
  const saveStatus = useApp((s) => s.saveStatus);
  const readOnly = useApp(selectReadOnly);
  const account = useApp((s) => s.account);
  // Undo/Redo 可否は zundo の temporal ストアから購読（§2.3）。
  const canUndo = useStore(useApp.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useApp.temporal, (s) => s.futureStates.length > 0);
  const fileRef = useRef<HTMLInputElement>(null);
  const mspdiRef = useRef<HTMLInputElement>(null);

  // ---- MSPDI（MS Project XML）連携（§8 / Phase5 下ごしらえ）----
  const doExportMspdi = () => {
    const s = useApp.getState();
    const doc = s.toDoc();
    const cpm = selectCpm(
      doc.tasks,
      doc.dependencies,
      doc.project.dataDate,
      selectActiveCalendar(s),
    );
    const blob = new Blob([toMspdi(doc, cpm)], { type: "application/xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.project.name}-${new Date().toISOString().slice(0, 10)}.mspdi.xml`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const doImportMspdi = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const { tasks, dependencies } = fromMspdi(reader.result as string);
        if (!tasks.length) {
          useApp.getState().showToast("MSPDIにタスクが見つかりません", true);
          return;
        }
        const doc = cloneDocWithNewIds(
          { ...emptyDoc(), tasks, dependencies },
          "MSPDI取込 " + new Date().toISOString().slice(0, 10),
        );
        const v = validateDoc(doc);
        if (!v.ok) {
          useApp
            .getState()
            .showToast(
              "取込検証エラー: " + v.errors.slice(0, 2).join(" / "),
              true,
            );
          return;
        }
        if (!(await flushPersistence().then(() => true, () => false))) return;
        useApp.getState().loadDoc(doc);
        useApp.getState().layoutAll(); // 位置(0,0)を左→右DAGへ整列
        useApp
          .getState()
          .showToast("MSPDIを取り込みました（" + tasks.length + "タスク）");
      } catch {
        useApp.getState().showToast("MSPDI解析に失敗しました", true);
      }
    };
    reader.onerror = () =>
      useApp.getState().showToast("ファイルを読み込めませんでした", true);
    reader.readAsText(file);
  };

  const doExport = () => downloadJson(useApp.getState().toDoc());
  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsedJson = JSON.parse(reader.result as string);
        let raw: unknown;
        try {
          const m = migrateDoc(parsedJson);
          raw = repairDoc(m.doc).doc;
        } catch (e) {
          useApp
            .getState()
            .showToast(e instanceof Error ? e.message : "移行に失敗しました", true);
          return;
        }
        const v = validateDoc(raw);
        if (!v.ok) {
          useApp
            .getState()
            .showToast(
              "インポート検証エラー: " + v.errors.slice(0, 2).join(" / "),
              true,
            );
          return;
        }
        // 既存プロジェクトの行を上書きしないよう、常に新規IDの別プロジェクトとして取り込む。
        const parsed = parseDoc(raw)!;
        const doc = cloneDocWithNewIds(parsed, parsed.project.name);
        // 未保存の編集を失わないよう、保存に失敗したら取込を中止する（失敗の通知は flushPersistence が出す）。
        if (!(await flushPersistence().then(() => true, () => false))) return;
        useApp.getState().loadDoc(doc);
        useApp.getState().fit(200);
        useApp
          .getState()
          .showToast("インポートしました（" + doc.tasks.length + "タスク）");
      } catch {
        useApp.getState().showToast("JSON解析に失敗しました", true);
      }
    };
    reader.onerror = () =>
      useApp.getState().showToast("ファイルを読み込めませんでした", true);
    reader.readAsText(file);
  };

  return (
    <header className="header">
      <span className="header-project-icon">
        <Icon name="folder" size={17} />
      </span>
      <ProjectBar />
      <button
        className="btn"
        disabled={!canUndo || readOnly}
        onClick={() => useApp.getState().undo()}
      >
        ↶ 戻す
      </button>
      <button
        className="btn"
        disabled={!canRedo || readOnly}
        onClick={() => useApp.getState().redo()}
      >
        進む ↷
      </button>
      {API_MODE && readOnly ? (
        <span className="role-badge" data-testid="readonly-badge" title="このプロジェクトは閲覧のみ可能です">
          閲覧のみ
        </span>
      ) : null}
      <span className="spacer" />
      {API_MODE && account ? (
        <span className="account-chip" data-testid="account-email" title="ログイン中のユーザー">
          {account.email}
        </span>
      ) : null}
      <button
        className="icon-button header-search"
        aria-label="タスクを検索"
        title="タスクを検索"
        onClick={() =>
          window.dispatchEvent(
            new KeyboardEvent("keydown", { key: "k", metaKey: true }),
          )
        }
      >
        <Icon name="search" size={17} />
      </button>
      <ActionsMenu onNewProject={onNewProject} onSettings={onSettings} onMembers={onMembers} />
      <DataMenu
        onJsonExport={doExport}
        onJsonImport={() => fileRef.current?.click()}
        onMspdiExport={doExportMspdi}
        onMspdiImport={() => mspdiRef.current?.click()}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".json,.epcgraph.json"
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.[0]) doImport(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={mspdiRef}
        type="file"
        accept=".xml,.mspdi.xml"
        style={{ display: "none" }}
        data-testid="mspdi-file"
        onChange={(e) => {
          if (e.target.files?.[0]) doImportMspdi(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <span className={"savebadge " + saveStatus} data-testid="savebadge">
        {API_MODE
          ? saveStatus === "saved"
            ? "保存済み"
            : saveStatus === "error"
              ? "保存できません（再試行中）"
              : saveStatus === "conflict"
                ? "競合を確認してください"
                : "保存中…"
          : saveStatus === "saved"
            ? "このブラウザに保存済み"
            : saveStatus === "error"
              ? "保存できませんでした"
              : "保存中…"}
      </span>
    </header>
  );
}

export function Breadcrumb() {
  const task = useSelectedTask();
  if (!task) return <div className="breadcrumb">タスク未選択</div>;
  const path = wbsPath(task.wbsCode);
  return (
    <div className="breadcrumb">
      WBS:{" "}
      {path.length
        ? path.map((p, i) => (
            <span key={p}>
              {i > 0 ? " › " : ""}
              <span
                className="crumb"
                onClick={() =>
                  useApp.getState().setFilter({ wbsPrefixes: [p] })
                }
              >
                {p}
              </span>
            </span>
          ))
        : "（ルート直下）"}
      {" › "}
      <b>{task.name}</b>
    </div>
  );
}
