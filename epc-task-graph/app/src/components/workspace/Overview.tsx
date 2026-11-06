import { useMemo } from "react";
import { useApp } from "../../store/store";
import { useCpm } from "../../store/hooks";
import {
  deriveInsights,
  weightedProgress,
  shortDate,
} from "../../domain/insights";
import {
  DISC_LABEL,
  STATUS_LABEL,
  type ActiveView,
  type Task,
} from "../../domain";
import { Icon } from "./Icon";

export function Overview({
  onNavigate,
  onCreate,
}: {
  onNavigate: (view: ActiveView) => void;
  onCreate: () => void;
}) {
  const tasks = useApp((s) => s.tasks),
    deps = useApp((s) => s.dependencies),
    project = useApp((s) => s.project);
  const cpm = useCpm();
  const data = useMemo(
    () => deriveInsights(tasks, deps, cpm),
    [tasks, deps, cpm],
  );
  const select = (t: Task) => {
    useApp.getState().clearFilter();
    useApp.getState().clearFocus();
    useApp.getState().revealTask(t.id);
    onNavigate("graph");
  };
  const showCritical = () => {
    useApp.getState().quickCriticalOnly();
    onNavigate("graph");
  };
  if (!tasks.length)
    return (
      <div className="overview-empty">
        <span className="empty-emblem">
          <Icon name="graph" size={36} />
        </span>
        <h2>最初のタスクから、工程をつなげよう。</h2>
        <p>タスクを追加し、先行・後続の関係をつなぐと工程が見えてきます。</p>
        <button className="btn primary" onClick={onCreate}>
          <Icon name="plus" />
          タスクを追加
        </button>
        <span>既存の工程は、上部の「データ」から取り込めます。</span>
      </div>
    );
  return (
    <div className="overview-scroll">
      <section className="metrics" aria-label="プロジェクト指標">
        <div className="metric">
          <div className="metric-label">
            全体の進捗
            <Icon name="overview" />
          </div>
          <div className="metric-value">
            {data.progress}
            <span>%</span>
          </div>
          <div className="progress-track">
            <i style={{ width: `${data.progress}%` }} />
          </div>
          <div className="metric-note">
            {tasks.length}タスクのうち {data.done}件完了{" "}
            <span>所要日数で加重</span>
          </div>
        </div>
        <button
          className="metric metric-action"
          onClick={() => onNavigate("gantt")}
        >
          <div className="metric-label">
            計算上の完了日
            <Icon name="gantt" />
          </div>
          <div className="metric-value date-value">
            {shortDate(cpm.projectEndDate)}
            <span>{cpm.projectEndDate.slice(0, 4)}</span>
          </div>
          <div className="metric-note">
            基準日から {cpm.projectEnd} 暦日 <Icon name="arrow" size={15} />
          </div>
        </button>
        <button className="metric metric-action" onClick={showCritical}>
          <div className="metric-label">
            未完了の重要工程
            <Icon name="graph" />
          </div>
          <div className="metric-value">
            {data.critical.length}
            <span>件</span>
          </div>
          <div className="metric-note">
            <span className="signal red" />
            完了日を左右する工程
            <Icon name="arrow" size={15} />
          </div>
        </button>
        <button
          className="metric metric-action attention-metric"
          onClick={() => {
            useApp.getState().clearFilter();
            useApp.getState().setFilter({ statuses: ["ON_HOLD"] });
            useApp.getState().setDisplayMode("ISOLATE");
            onNavigate("table");
          }}
        >
          <div className="metric-label">
            保留中のタスク
            <Icon name="alert" />
          </div>
          <div className="metric-value">
            {tasks.filter((t) => t.status === "ON_HOLD").length}
            <span>件</span>
          </div>
          <div className="metric-note">
            <span className="signal amber" />
            再開に向けた確認が必要
            <Icon name="arrow" size={15} />
          </div>
        </button>
      </section>
      <div className="overview-grid">
        <section className="surface schedule-summary">
          <div className="section-heading">
            <div>
              <span className="eyebrow">PROJECT TIMELINE</span>
              <h2>工程の見通し</h2>
            </div>
            <button className="text-button" onClick={() => onNavigate("gantt")}>
              ガントで開く
              <Icon name="arrow" size={16} />
            </button>
          </div>
          <div className="timeline-scale">
            <span>基準日 {shortDate(project.dataDate)}</span>
            <span>計算上の完了 {shortDate(cpm.projectEndDate)}</span>
          </div>
          <div className="phase-timeline">
            {data.groups.map((g) => {
              const results = g.tasks.flatMap(
                  (t) => cpm.byTask.get(t.id) ?? [],
                ),
                start = Math.min(...results.map((r) => r.es)),
                end = Math.max(...results.map((r) => r.ef));
              return (
                <button
                  className="phase-row"
                  key={g.discipline}
                  onClick={() => {
                    useApp.getState().clearFilter();
                    useApp
                      .getState()
                      .setFilter({ disciplines: [g.discipline] });
                    useApp.getState().setDisplayMode("ISOLATE");
                    onNavigate("gantt");
                  }}
                >
                  <span className="phase-label">
                    <b className={"disc-letter " + g.discipline}>
                      {g.discipline}
                    </b>
                    <span>
                      {DISC_LABEL[g.discipline]}
                      <small>{g.tasks.length}タスク</small>
                    </span>
                  </span>
                  <span className="phase-track">
                    <i
                      className={"phase-bar " + g.discipline}
                      style={{
                        left: `${(start / Math.max(1, cpm.projectEnd)) * 100}%`,
                        width: `${Math.max(2, ((end - start) / Math.max(1, cpm.projectEnd)) * 100)}%`,
                      }}
                    >
                      <span>
                        {shortDate(results.find((r) => r.es === start)?.esDate)}{" "}
                        — {shortDate(results.find((r) => r.ef === end)?.efDate)}
                      </span>
                    </i>
                  </span>
                  <span className="phase-percent">
                    {weightedProgress(g.tasks)}
                    <small>%</small>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="timeline-foot">
            <span>
              <i className="signal blue" />
              設計
            </span>
            <span>
              <i className="signal amber" />
              調達
            </span>
            <span>
              <i className="signal green" />
              施工
            </span>
            <span className="timeline-explain">
              依存関係・稼働カレンダーから計算
            </span>
          </div>
        </section>
        <section className="surface milestone-summary">
          <div className="section-heading">
            <div>
              <span className="eyebrow">KEY DATES</span>
              <h2>マイルストーン</h2>
            </div>
            <span className="count-pill">{data.milestones.length}</span>
          </div>
          <div className="milestone-list">
            {data.milestones.length ? (
              data.milestones.slice(0, 5).map((t) => (
                <button
                  key={t.id}
                  className="milestone-row"
                  onClick={() => select(t)}
                >
                  <span
                    className={
                      "milestone-marker " + (t.status === "DONE" ? "done" : "")
                    }
                  >
                    {t.status === "DONE" ? (
                      <Icon name="check" size={13} />
                    ) : (
                      <span />
                    )}
                  </span>
                  <span className="milestone-name">
                    {t.name}
                    <small>{STATUS_LABEL[t.status]}</small>
                  </span>
                  <time>{shortDate(cpm.byTask.get(t.id)?.efDate)}</time>
                </button>
              ))
            ) : (
              <p className="quiet-empty">
                節目となるタスクをマイルストーンに設定すると、ここに表示されます。
              </p>
            )}
          </div>
        </section>
        <section className="surface critical-summary">
          <div className="section-heading">
            <div>
              <span className="eyebrow">FOCUS NEXT</span>
              <h2>完了日を左右するタスク</h2>
            </div>
            <button className="text-button" onClick={showCritical}>
              依存関係を見る
              <Icon name="arrow" size={16} />
            </button>
          </div>
          <div className="critical-table">
            <div className="critical-table-head">
              <span>タスク / 担当</span>
              <span>ステータス</span>
              <span>所要日数</span>
              <span>終了予定</span>
            </div>
            {data.critical.slice(0, 5).map((t) => (
              <button
                className="critical-row"
                key={t.id}
                onClick={() => select(t)}
              >
                <span className="critical-task-name">
                  <span className={"task-square " + t.discipline} />
                  <span>
                    {t.name}
                    <small>
                      {t.wbsCode} · {t.assignee || "担当未設定"}
                    </small>
                  </span>
                </span>
                <span className={"status-pill " + t.status}>
                  {STATUS_LABEL[t.status]}
                </span>
                <span>
                  {t.durationDays} <small>日</small>
                </span>
                <span>
                  {shortDate(cpm.byTask.get(t.id)?.efDate)}
                  <Icon name="chevron" size={14} />
                </span>
              </button>
            ))}
            {!data.critical.length && (
              <p className="quiet-empty">
                未完了のクリティカルタスクはありません。
              </p>
            )}
          </div>
          <div className="section-foot">
            <span className="signal red" />
            余裕日数が0日以下の未完了タスク · 全{data.critical.length}件
          </div>
        </section>
        <section className="surface attention-summary">
          <div className="section-heading">
            <div>
              <span className="eyebrow">NEEDS ATTENTION</span>
              <h2>確認しておきたいこと</h2>
            </div>
            <Icon name="alert" />
          </div>
          {data.attention.slice(0, 3).map((t) => (
            <button
              className="attention-item"
              key={t.id}
              onClick={() => select(t)}
            >
              <span className="attention-dot" />
              <span>
                <strong>{t.name}</strong>
                <small>
                  {t.status === "ON_HOLD"
                    ? "保留中です。再開条件を確認してください。"
                    : "日付制約を満たせない工程です。所要日数や依存関係を確認してください。"}
                </small>
                <em>
                  {t.assignee || "担当未設定"}
                  <Icon name="arrow" size={14} />
                </em>
              </span>
            </button>
          ))}
          {!data.attention.length && (
            <div className="attention-clear">
              <Icon name="check" size={26} />
              <strong>確認事項はありません</strong>
              <p>保留や日付制約の超過をここで確認できます。</p>
            </div>
          )}
          <div className="section-foot">
            基準日 {project.dataDate} の工程計算
          </div>
        </section>
      </div>
      <footer className="workspace-foot">
        <span>
          C-Relations<span className="foot-dot">·</span>
          工程のつながりを、次の判断へ。
        </span>
        <span>
          <Icon name="check" size={14} />
          このブラウザに自動保存
        </span>
      </footer>
    </div>
  );
}
