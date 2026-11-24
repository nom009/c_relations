import { Icon } from "./workspace/Icon";
// ヘッダ/ツールバー（§1.3）: プロジェクト切替・CP強調・完了日・作成・整列・Undo/Redo・
//   デモ生成・Export/Import・保存状態。
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { useApp, selectActiveCalendar, selectReadOnly, flushPersistence } from "../store/store";
import { API_MODE, DEMO_MODE } from "../storage/mode";
import { modKey, modShiftKey } from "./keyboard";
import { selectCpm } from "../store/selectors";
import { downloadJson } from "../store/backup";
import { useSelectedTask } from "../store/hooks";
import { validateDoc, parseDoc, cloneDocWithNewIds, wbsPath, toMspdi, fromMspdi, emptyDoc, migrateDoc, repairDoc, toCsv, fromCsv, csvTemplate, decodeCsvBytes, planCsvMerge, type CsvImportResult, type CsvMergePlan } from "../domain";
import { MessageListDialog } from "./workspace/MessageListDialog";
import { CsvMergeDialog } from "./workspace/CsvMergeDialog";

// UTF-8(BOM付き) で保存する＝Excel でダブルクリックしても文字化けしない。
function downloadCsv(text: string, filename: string) {
  const blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// CSV 取込のダイアログ状態（エラー/注意の一覧、または更新前の確認）。
type CsvDialogState =
  | { kind: "messages"; title: string; lead: string; messages: string[] }
  | { kind: "merge"; fileName: string; imported: CsvImportResult; plan: CsvMergePlan };

// データ入出力メニュー（ツールバー整理・§1.3）: JSON/MSPDI/CSV の出力・取込を1つのドロップダウンに集約。
function DataMenu({
  onJsonExport,
  onJsonImport,
  onMspdiExport,
  onMspdiImport,
  onCsvTemplate,
  onCsvExport,
  onCsvImport,
  onCsvUpdate,
}: {
  onJsonExport: () => void;
  onJsonImport: () => void;
  onMspdiExport: () => void;
  onMspdiImport: () => void;
  onCsvTemplate: () => void;
  onCsvExport: () => void;
  onCsvImport: () => void;
  // 閲覧のみ（viewer）では渡さない＝メニューに出さない。
  onCsvUpdate?: () => void;
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
          <div className="menu-sep" />
          {item("CSVテンプレートを書き出す", onCsvTemplate)}
          {item("CSV（Excel）を書き出す", onCsvExport)}
          {item("CSV（Excel）から新規プロジェクトを作成…", onCsvImport)}
          {onCsvUpdate ? item("CSV（Excel）で現在のプロジェクトを更新…", onCsvUpdate) : null}
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

// 操作メニュー（二次操作を集約・大胆に隠す）: プロジェクト管理・整列・ベースライン・デモ生成。
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
  const readOnly = useApp(selectReadOnly);
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
          {!readOnly ? (
            <>
              <div className="menu-sep" />
              {item("ベースラインを保存（現在の計画）", () =>
                useApp.getState().setBaseline(),
              )}
              {item("ベースラインをクリア", () => {
                if (
                  confirm(
                    "全タスクのベースラインをクリアしますか？（元に戻すで復元できます）",
                  )
                )
                  useApp.getState().clearBaseline();
              })}
            </>
          ) : null}
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
  const saveLabel = API_MODE
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
        : "保存中…";
  const readOnly = useApp(selectReadOnly);
  const account = useApp((s) => s.account);
  // Undo/Redo 可否は zundo の temporal ストアから購読（§2.3）。
  const canUndo = useStore(useApp.temporal, (s) => s.pastStates.length > 0);
  const canRedo = useStore(useApp.temporal, (s) => s.futureStates.length > 0);
  const fileRef = useRef<HTMLInputElement>(null);
  const mspdiRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const csvUpdateRef = useRef<HTMLInputElement>(null);
  const [csvDialog, setCsvDialog] = useState<CsvDialogState | null>(null);

  // ---- CSV（Excel）連携: 標準テンプレート列。新規プロジェクト作成と、現在のプロジェクトの更新（ID照合）----
  const doCsvTemplate = () => downloadCsv(csvTemplate(), "タスク取込テンプレート.csv");
  const doExportCsv = () => {
    const doc = useApp.getState().toDoc();
    downloadCsv(
      toCsv(doc.tasks, doc.dependencies),
      `${doc.project.name}-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  };
  const doImportCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const app = () => useApp.getState();
      try {
        const r = fromCsv(decodeCsvBytes(reader.result as ArrayBuffer));
        if (r.errors.length) {
          app().showToast(`CSVに ${r.errors.length} 件のエラーがあるため取り込みを中止しました`, true);
          setCsvDialog({
            kind: "messages",
            title: "CSVのエラー",
            lead: "CSVを修正してから再度読み込んでください。",
            messages: r.errors,
          });
          return;
        }
        const base = { ...emptyDoc(), tasks: r.tasks, dependencies: r.dependencies };
        if (r.earliestStart) base.project = { ...base.project, dataDate: r.earliestStart };
        const name = file.name.replace(/\.csv$/i, "") || "CSV取込";
        const doc = cloneDocWithNewIds(base, name);
        const v = validateDoc(doc);
        if (!v.ok) {
          app().showToast("取込検証エラー: " + v.errors.slice(0, 2).join(" / "), true);
          return;
        }
        if (!(await flushPersistence().then(() => true, () => false))) return;
        app().loadDoc(doc);
        app().layoutAll();
        app().showToast(
          `CSVを取り込みました（${doc.tasks.length}タスク・${doc.dependencies.length}依存）` +
            (r.warnings.length ? `／注意 ${r.warnings.length} 件` : ""),
        );
        if (r.warnings.length)
          setCsvDialog({
            kind: "messages",
            title: "CSV取込の注意",
            lead: "取り込みました。以下を確認してください。",
            messages: r.warnings,
          });
      } catch {
        app().showToast("CSV解析に失敗しました", true);
      }
    };
    reader.onerror = () => useApp.getState().showToast("ファイルを読み込めませんでした", true);
    reader.readAsArrayBuffer(file);
  };
  // 現在のプロジェクトを CSV で更新: ID で照合し、確認ダイアログを経て1回の「戻す」単位で反映する。
  const doUpdateCsv = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const app = useApp.getState();
      try {
        const r = fromCsv(decodeCsvBytes(reader.result as ArrayBuffer), app.me);
        if (r.errors.length) {
          app.showToast(`CSVに ${r.errors.length} 件のエラーがあるため更新を中止しました`, true);
          setCsvDialog({
            kind: "messages",
            title: "CSVのエラー",
            lead: "CSVを修正してから再度読み込んでください。現在のプロジェクトは変更していません。",
            messages: r.errors,
          });
          return;
        }
        const plan = planCsvMerge({ tasks: app.tasks, dependencies: app.dependencies }, r);
        const s = plan.summary;
        if (!s.added && !s.updated && !s.removed && !s.depsAdded && !s.depsRemoved && !s.depsUpdated) {
          app.showToast("CSVの内容は現在のプロジェクトと同じです（変更はありません）");
          return;
        }
        setCsvDialog({ kind: "merge", fileName: file.name, imported: r, plan });
      } catch {
        app.showToast("CSV解析に失敗しました", true);
      }
    };
    reader.onerror = () => useApp.getState().showToast("ファイルを読み込めませんでした", true);
    reader.readAsArrayBuffer(file);
  };
  const applyCsvUpdate = (imported: CsvImportResult) => {
    setCsvDialog(null);
    const app = useApp.getState();
    if (selectReadOnly(app)) {
      app.showToast("閲覧のみのため更新できません", true);
      return;
    }
    // 確認中に編集・同期が入っていてもよいよう、最新の状態に対して計画し直す。
    const plan = planCsvMerge({ tasks: app.tasks, dependencies: app.dependencies }, imported);
    const v = validateDoc({ ...app.toDoc(), tasks: plan.tasks, dependencies: plan.dependencies });
    if (!v.ok) {
      app.showToast("取込検証エラー: " + v.errors.slice(0, 2).join(" / "), true);
      return;
    }
    app.applyCsvMerge(plan);
    const s = plan.summary;
    // 全体整列は既存ノードも動かすため、タスクを追加したときだけ行う。
    if (s.added > 0) useApp.getState().layoutAll();
    useApp
      .getState()
      .showToast(
        `CSVで更新しました（追加 ${s.added}・更新 ${s.updated}・削除 ${s.removed}／依存 追加 ${s.depsAdded}・削除 ${s.depsRemoved}）` +
          (imported.warnings.length ? `／注意 ${imported.warnings.length} 件` : ""),
      );
    if (imported.warnings.length)
      setCsvDialog({
        kind: "messages",
        title: "CSV取込の注意",
        lead: "更新しました。以下を確認してください。",
        messages: imported.warnings,
      });
  };

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
        const { tasks, dependencies, wbsNames } = fromMspdi(reader.result as string);
        if (!tasks.length) {
          useApp.getState().showToast("MSPDIにタスクが見つかりません", true);
          return;
        }
        const base = emptyDoc();
        if (Object.keys(wbsNames).length) base.project.wbsNames = wbsNames;
        const doc = cloneDocWithNewIds(
          { ...base, tasks, dependencies },
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
        className="btn header-undo"
        disabled={!canUndo || readOnly}
        onClick={() => useApp.getState().undo()}
        title={`元に戻す（${modKey("Z")}）`}
        aria-label="元に戻す"
      >
        <span aria-hidden="true">↶</span>
        <span className="header-undo-label">戻す</span>
      </button>
      <button
        className="btn header-undo"
        disabled={!canRedo || readOnly}
        onClick={() => useApp.getState().redo()}
        title={`やり直す（${modShiftKey("Z")}）`}
        aria-label="進む（やり直す）"
      >
        <span className="header-undo-label">進む</span>
        <span aria-hidden="true">↷</span>
      </button>
      {API_MODE && readOnly ? (
        <span className="role-badge" data-testid="readonly-badge" title="このプロジェクトは閲覧のみ可能です">
          閲覧のみ
        </span>
      ) : null}
      {DEMO_MODE ? (
        <span
          className="role-badge"
          data-testid="demo-badge"
          title="公開デモ版です。データはこのブラウザにのみ保存され、他の人とは共有されません。"
        >
          デモ版
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
        onCsvTemplate={doCsvTemplate}
        onCsvExport={doExportCsv}
        onCsvImport={() => csvRef.current?.click()}
        onCsvUpdate={readOnly ? undefined : () => csvUpdateRef.current?.click()}
      />
      <input
        ref={csvRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        data-testid="csv-file"
        onChange={(e) => {
          if (e.target.files?.[0]) doImportCsv(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={csvUpdateRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        data-testid="csv-update-file"
        onChange={(e) => {
          if (e.target.files?.[0]) doUpdateCsv(e.target.files[0]);
          e.target.value = "";
        }}
      />
      {csvDialog?.kind === "messages" ? (
        <MessageListDialog
          title={csvDialog.title}
          lead={csvDialog.lead}
          messages={csvDialog.messages}
          testId="csv-messages"
          onClose={() => setCsvDialog(null)}
        />
      ) : csvDialog?.kind === "merge" ? (
        <CsvMergeDialog
          fileName={csvDialog.fileName}
          plan={csvDialog.plan}
          hasIds={csvDialog.imported.hasIds}
          warningCount={csvDialog.imported.warnings.length}
          onApply={() => applyCsvUpdate(csvDialog.imported)}
          onClose={() => setCsvDialog(null)}
        />
      ) : null}
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
      {/* 保存状態は常に表示。狭い幅ではドットのみ（文言は title と視覚的に隠したテキストで保持） */}
      <span
        className={"savebadge " + saveStatus}
        data-testid="savebadge"
        title={saveLabel}
      >
        <span className="savebadge-dot" aria-hidden="true" />
        <span className="savebadge-text">{saveLabel}</span>
        {saveStatus === "error" || saveStatus === "conflict" ? (
          <span className="savebadge-short" aria-hidden="true">
            {saveStatus === "error" ? "保存エラー" : "競合"}
          </span>
        ) : null}
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
