import { Icon } from "./workspace/Icon";
// ============================================================================
// View Shell（§12.2）: グラフ/テーブル/ガント(disabled) のタブ＋器。
// マウント戦略: 非アクティブ側は display:none で常駐（レイアウト計算が止まり最軽量。
//   ビューポート/スクロール位置/選択が保たれる）。復帰時に fitView は呼ばない。
// 選択・フィルタ・折り畳みはストア共有状態なので「同期は基本なにもしない」で成立する。
// ============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store/store";
import {
  isFilterActive,
  matchesFilter,
  STATUS_LABEL,
  type ActiveView,
} from "../domain";
import { useCpm } from "../store/hooks";
import { CanvasArea } from "./CanvasArea";
import { TableView } from "./table/TableView";
import { GanttView } from "./gantt/GanttView";

// フィルタ状態バナー（何で絞っているかを一目で・件数つき・ワンクリック解除）。
// 「filter したものだけを分かりやすく」の中核: 今の絞り込みを言語化して常に見せる。
function describeFilter(f: any, me: string): string[] {
  const parts: string[] = [];
  if (f.assignees?.length) {
    const a = f.assignees[0] === "@me" ? `自分（${me}）` : f.assignees[0];
    parts.push("担当: " + a);
  }
  if (f.criticalOnly) parts.push("クリティカルパス");
  if (f.milestonesOnly) parts.push("マイルストーン");
  if (f.disciplines?.length) parts.push("工種: " + f.disciplines.join("・"));
  if (f.statuses?.length)
    parts.push(
      "状態: " +
        f.statuses
          .map((s: string) => STATUS_LABEL[s as keyof typeof STATUS_LABEL])
          .join("・"),
    );
  if (f.wbsPrefixes?.length) parts.push("WBS: " + f.wbsPrefixes.join("・"));
  if (f.text?.trim()) parts.push(`検索「${f.text.trim()}」`);
  return parts;
}

function FilterBanner() {
  const viewSpec = useApp((s) => s.viewSpec);
  const tasks = useApp((s) => s.tasks);
  const me = useApp((s) => s.me);
  const focus = viewSpec.focus;
  const cpm = useCpm();
  const active = isFilterActive(viewSpec.filter);
  const matched = useMemo(() => {
    if (!active) return 0;
    let n = 0;
    for (const t of tasks)
      if (matchesFilter(t, viewSpec.filter, me, cpm.criticalTasks)) n++;
    return n;
  }, [active, tasks, viewSpec.filter, me, cpm]);

  if (!active && !focus) return null; // 絞り込みも近傍もなければ非表示

  const parts = active ? describeFilter(viewSpec.filter, me) : [];
  const bu = viewSpec.boundaryUp || 0;
  const bd = viewSpec.boundaryDown || 0;
  if (active && (bu || bd)) parts.push(`受け渡し 前${bu}/後${bd}`);
  if (focus) parts.push("近傍フォーカス中");

  return (
    <div className="filter-banner" data-testid="filter-banner">
      <span className="fb-dot" />
      <span className="fb-label">絞り込み中</span>
      <span className="fb-desc">{parts.join(" ・ ")}</span>
      {active ? (
        <span className="fb-count" data-testid="filter-count">
          {matched}件
        </span>
      ) : null}
      <button
        className="fb-clear"
        data-testid="filter-clear"
        onClick={() => {
          useApp.getState().clearFilter();
          useApp.getState().clearFocus();
        }}
      >
        すべて表示 ✕
      </button>
    </div>
  );
}

// 操作マニュアル（タブ横ヘルプ）。実運用の「まず絞る→それから見る」ワークフローと主要操作を
// その場で確認できる。4,000件を一度に見るのは非現実的なので、絞り込み導線を最上段に置く。
function HelpButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="help" ref={ref}>
      <button
        className="help-btn"
        data-testid="help-btn"
        title="操作マニュアル"
        onClick={() => setOpen((o) => !o)}
      >
        ？ 使い方
      </button>
      {open ? (
        <div className="help-pop" data-testid="help-pop">
          <h4>まず絞る → それから見る</h4>
          <p className="help-lead">
            4,000件を一度に見るのは非現実的です。
            <b>担当・工区・CPで絞ってから</b>グラフ／テーブル
            ／ガントで確認するのが実運用の基本です。
          </p>
          <div className="help-sec">絞り込み（左パネル）</div>
          <ul>
            <li>
              <b>自分のタスク</b> … 自分の部署だけ抽出
            </li>
            <li>
              <b>CPのみ</b> … 遅れると全体が遅れる背骨だけ
            </li>
            <li>
              <b>WBSツリー</b> … 工区（枝）をクリックでその範囲だけ
            </li>
            <li>
              <b>保存ビュー ★</b> … よく使う絞り込みを起動時に自動適用
            </li>
          </ul>
          <div className="help-sec">3つのビュー</div>
          <ul>
            <li>
              <b>グラフ（G）</b> … 依存関係を編集。ハンドルからドラッグで接続
            </li>
            <li>
              <b>テーブル（T）</b> … 一覧・並べ替え・一括編集
            </li>
            <li>
              <b>ガント（Y）</b> … 時間軸。バー右端ドラッグで工期変更
            </li>
          </ul>
          <div className="help-sec">主なキー操作</div>
          <ul className="help-keys">
            <li>
              <kbd>G</kbd>/<kbd>T</kbd>/<kbd>Y</kbd> ビュー切替
            </li>
            <li>
              <kbd>⌘/Ctrl</kbd>+<kbd>K</kbd> 検索してジャンプ
            </li>
            <li>
              <kbd>H</kbd> 選択タスクの関係先をハイライト（世代指定可）
            </li>
            <li>
              <kbd>N</kbd> 新規タスク ／ <kbd>Tab</kbd> 後続を作成
            </li>
            <li>
              <kbd>Delete</kbd> 削除 ／ <kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd> 取り消し
            </li>
          </ul>
          <div className="help-sec">データ</div>
          <ul>
            <li>
              <b>データ ▾</b> … JSON / MS Project(MSPDI) の出力・取込
            </li>
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Tab({
  view,
  label,
  disabled,
  hint,
}: {
  view: ActiveView;
  label: string;
  disabled?: boolean;
  hint?: string;
}) {
  const active = useApp((s) => s.activeView === view);
  return (
    <button
      aria-pressed={active}
      className={"viewtab" + (active ? " active" : "")}
      disabled={disabled}
      data-testid={"viewtab-" + view}
      onClick={() => !disabled && useApp.getState().setActiveView(view)}
      title={
        disabled ? "Phase 3 で提供予定" : hint ? `${label}（${hint}）` : label
      }
    >
      {label}
      {hint ? <span className="viewtab-key">{hint}</span> : null}
      {disabled ? <span className="soon">（近日）</span> : null}
    </button>
  );
}

export function ViewShell() {
  const activeView = useApp((s) => s.activeView);
  const critical = useApp((s) => s.cpHighlight);

  // グラフへ復帰した時: 選択対象を必ず見せる（祖先WBS展開＋センタリング）。§12.2。
  useEffect(() => {
    if (activeView !== "graph") return;
    const s = useApp.getState();
    if (s.selection.taskId) {
      s.revealTask(s.selection.taskId);
      // 展開反映後にパン（センタリングのみ・fitViewはしない）。
      setTimeout(() => useApp.getState().runners.centerSelected?.(), 60);
    }
  }, [activeView]);

  // テーブルへ復帰した時: 折り畳み中の祖先を展開（スクロール追従は TableView 側）。
  useEffect(() => {
    if (activeView !== "table") return;
    const s = useApp.getState();
    if (s.selection.taskId) s.revealTask(s.selection.taskId);
  }, [activeView]);

  // ビュー切替ショートカット（G/T/Y）は App のグローバルキー処理が一元的に扱う。

  return (
    <div className="viewshell">
      <div className="viewtabs-bar">
        <div className="viewtabs">
          <Tab view="graph" label="依存関係" hint="G" />
          <Tab view="table" label="タスク一覧" hint="T" />
          <Tab view="gantt" label="ガント" hint="Y" />
        </div>
        <div className="view-toolbar-actions">
          <select
            className="graph-density"
            aria-label="工程の表示階層"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value === "group") useApp.getState().collapseAll();
              else if (e.target.value === "all")
                useApp.getState().setExpandLevel(99);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              表示階層
            </option>
            <option value="group">工区ごとにまとめる</option>
            <option value="all">タスクをすべて展開</option>
          </select>
          <button
            className={"btn critical-toggle" + (critical ? " on" : "")}
            aria-pressed={critical}
            data-testid="cp-toggle"
            onClick={() => useApp.getState().toggleCpHighlight()}
          >
            <Icon name="graph" size={15} />
            クリティカルパス
          </button>
          <HelpButton />
        </div>
      </div>
      <FilterBanner />
      <div className="viewstack">
        <div
          className="view-pane"
          style={{ display: activeView === "graph" ? "flex" : "none" }}
        >
          <CanvasArea />
        </div>
        <div
          className="view-pane"
          style={{ display: activeView === "table" ? "flex" : "none" }}
        >
          <TableView active={activeView === "table"} />
        </div>
        <div
          className="view-pane"
          style={{ display: activeView === "gantt" ? "flex" : "none" }}
        >
          <GanttView active={activeView === "gantt"} />
        </div>
      </div>
    </div>
  );
}
