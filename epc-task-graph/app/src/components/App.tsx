import { TaskDialog } from "./workspace/TaskDialog";
import { SettingsDialog } from "./workspace/SettingsDialog";
import { lazy, Suspense, useEffect, useState } from "react";
import { useApp, selectReadOnly } from "../store/store";
import { API_MODE } from "../storage/mode";
import type { ActiveView } from "../domain";
import { Header } from "./Header";
import { LeftPanel } from "./LeftPanel";
import { RightPanel } from "./RightPanel";
import { SearchPalette } from "./SearchPalette";
import { Overview } from "./workspace/Overview";
import { Icon, type IconName } from "./workspace/Icon";

// サーバー版専用ダイアログ。ローカル版ビルドでは定数分岐で除去され、チャンクも生成されない。
const ConflictDialog = API_MODE
  ? lazy(() =>
      import("./workspace/ConflictDialog").then((m) => ({
        default: m.ConflictDialog,
      })),
    )
  : null;
const MembersDialog = API_MODE
  ? lazy(() =>
      import("./workspace/MembersDialog").then((m) => ({
        default: m.MembersDialog,
      })),
    )
  : null;

// 作業ビュー（React Flow / dagre / 仮想化テーブル / ガント）は別チャンク。概要画面を先に描画し、
// アイドル時に先読みしておく。
const loadViewShell = () => import("./ViewShell");
const ViewShell = lazy(() => loadViewShell().then((m) => ({ default: m.ViewShell })));

const views: { id: ActiveView; label: string; icon: IconName; key: string }[] =
  [
    { id: "graph", label: "依存関係", icon: "graph", key: "G" },
    { id: "gantt", label: "ガントチャート", icon: "gantt", key: "Y" },
    { id: "table", label: "タスク一覧", icon: "table", key: "T" },
  ];
export function App() {
  const [overview, setOverview] = useState(true),
    [filters, setFilters] = useState(false),
    [dialog, setDialog] = useState<
      "task" | "settings" | "project" | "members" | null
    >(null);
  const me = useApp((s) => s.me);
  const readOnly = useApp(selectReadOnly),
    conflict = useApp((s) => s.conflict);
  const activeView = useApp((s) => s.activeView),
    selection = useApp((s) => s.selection.taskId),
    tasks = useApp((s) => s.tasks),
    project = useApp((s) => s.project),
    toast = useApp((s) => s.toast);
  const navigate = (v: ActiveView) => {
    useApp.getState().setActiveView(v);
    setOverview(false);
  };
  const create = () => {
    if (useApp.getState().role === "viewer") {
      useApp.getState().showToast("閲覧のみの権限です", true);
      return;
    }
    setDialog("task");
  };
  useEffect(() => {
    void loadViewShell();
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        el.closest?.("input,textarea,select,[contenteditable=true],dialog") ||
        document.querySelector("dialog[open]")
      )
        return;
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "z") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const s = useApp.getState();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const view = views.find((v) => v.key.toLowerCase() === key);
      if (view) {
        e.preventDefault();
        e.stopImmediatePropagation();
        useApp.getState().setActiveView(view.id);
        setOverview(false);
      }
      if (key === "n") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (useApp.getState().role === "viewer") {
          useApp.getState().showToast("閲覧のみの権限です", true);
          return;
        }
        setDialog("task");
      }
      if (key === "escape") setFilters(false);
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  return (
    <div className="app redesigned-app">
      <aside className="workspace-nav">
        <button
          title="プロジェクト概要"
          className="workspace-brand"
          onClick={() => setOverview(true)}
          aria-label="C-Relations ホーム"
        >
          <span className="brand-symbol">
            <Icon name="graph" size={23} />
          </span>
          <span>
            C-Relations<small>PROJECT WORKSPACE</small>
          </span>
        </button>
        <button
          className="nav-search"
          onClick={() =>
            window.dispatchEvent(
              new KeyboardEvent("keydown", { key: "k", metaKey: true }),
            )
          }
        >
          <Icon name="search" />
          <span>タスクを検索</span>
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-section-label">ワークスペース</div>
        <nav aria-label="メインナビゲーション">
          <button
            title="プロジェクト概要"
            aria-label="プロジェクト概要"
            aria-current={overview ? "page" : undefined}
            className={"nav-item " + (overview ? "active" : "")}
            onClick={() => setOverview(true)}
          >
            <Icon name="overview" />
            プロジェクト概要
          </button>
          {views.map((v) => (
            <button
              title={v.label}
              aria-label={v.label}
              aria-current={
                !overview && activeView === v.id ? "page" : undefined
              }
              className={
                "nav-item " +
                (!overview && activeView === v.id ? "active" : "")
              }
              key={v.id}
              onClick={() => navigate(v.id)}
            >
              <Icon name={v.icon} />
              {v.label}
              <kbd>{v.key}</kbd>
            </button>
          ))}
        </nav>
        <div className="nav-divider" />
        <div className="nav-section-label">クイックアクセス</div>
        <button
          className="nav-item"
          onClick={() => {
            useApp.getState().quickMyTasks();
            navigate("table");
          }}
        >
          <Icon name="folder" />
          自分のタスク
        </button>
        <button
          className="nav-item"
          onClick={() => {
            useApp.getState().quickCriticalOnly();
            navigate("graph");
          }}
        >
          <span className="signal red" />
          クリティカルパス
        </button>
        <button
          className="nav-item"
          onClick={() => {
            useApp.getState().clearFilter();
            useApp.getState().setFilter({ milestonesOnly: true });
            useApp.getState().setDisplayMode("ISOLATE");
            navigate("gantt");
          }}
        >
          <Icon name="spark" />
          マイルストーン
        </button>
        <div className="nav-bottom">
          <div className="local-notice">
            <span className="signal green" />
            <span>
              {API_MODE ? (
                <>
                  共有ワークスペース<small>データはサーバーに保存</small>
                </>
              ) : (
                <>
                  ローカルワークスペース<small>データはこのブラウザに保存</small>
                </>
              )}
            </span>
          </div>
          <div className="nav-user">
            <span className="user-avatar">{me.slice(0, 1)}</span>
            <span>
              {me}
              <small>工程管理</small>
            </span>
            <button
              className="icon-button"
              aria-label="ワークスペース設定"
              onClick={() => setDialog("settings")}
            >
              <Icon name="settings" />
            </button>
          </div>
        </div>
      </aside>
      <main className="workspace-main">
        <Header
          onNewProject={() => setDialog("project")}
          onSettings={() => setDialog("settings")}
          onMembers={() => setDialog("members")}
        />
        <div className="workspace-heading">
          <div>
            <div className="workspace-breadcrumb">
              ワークスペース
              <Icon name="chevron" size={12} />
              <span>{project.name}</span>
              {project.description.includes("サンプル") && (
                <span className="sample-badge">サンプル</span>
              )}
            </div>
            <h1>
              {overview
                ? "プロジェクト概要"
                : views.find((v) => v.id === activeView)?.label}
            </h1>
            <p>
              {overview
                ? "工程の現在地を確認して、次の一手へ。"
                : `${tasks.length}件のタスク · 変更はすべてのビューに反映されます`}
            </p>
          </div>
          <div className="heading-actions">
            {!overview && (
              <button
                aria-label="絞り込み"
                title="絞り込み"
                className={"btn " + (filters ? "on" : "")}
                onClick={() => setFilters((v) => !v)}
              >
                <Icon name="filter" />
                絞り込み
              </button>
            )}
            {!readOnly && (
              <button
                aria-label="タスクを追加"
                title="タスクを追加"
                className="btn primary"
                onClick={create}
              >
                <Icon name="plus" />
                タスクを追加
              </button>
            )}
          </div>
        </div>
        {overview ? (
          <Overview onNavigate={navigate} onCreate={create} />
        ) : (
          <div className="body editor-body">
            {filters && (
              <div className="filter-drawer">
                <div className="drawer-heading">
                  表示する範囲
                  <button
                    className="icon-button"
                    aria-label="絞り込みを閉じる"
                    onClick={() => setFilters(false)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <LeftPanel />
              </div>
            )}
            <Suspense fallback={<div className="viewshell" />}>
              <ViewShell />
            </Suspense>
            {selection && (
              <div className="inspector">
                <div className="drawer-heading">
                  タスクの詳細
                  <button
                    className="icon-button"
                    aria-label="詳細を閉じる"
                    onClick={() =>
                      useApp.getState().setSelection({ taskId: null })
                    }
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <RightPanel key={selection} />
              </div>
            )}
          </div>
        )}
      </main>
      <div className="toasts" role="status" aria-live="polite">
        {toast.map((t) => (
          <div key={t.id} className={"toast" + (t.err ? " err" : "")}>
            {t.msg}
          </div>
        ))}
      </div>
      <SearchPalette onPick={() => navigate("graph")} />
      {dialog === "task" && (
        <TaskDialog
          onClose={() => setDialog(null)}
          onCreated={() => navigate("table")}
        />
      )}{" "}
      {(dialog === "settings" || dialog === "project") && (
        <SettingsDialog
          key={dialog}
          isNew={dialog === "project"}
          onClose={() => {
            if (dialog === "project") setOverview(true);
            setDialog(null);
          }}
        />
      )}
      {API_MODE && (
        <Suspense fallback={null}>
          {dialog === "members" && MembersDialog && (
            <MembersDialog onClose={() => setDialog(null)} />
          )}
          {conflict && ConflictDialog && <ConflictDialog />}
        </Suspense>
      )}
    </div>
  );
}
