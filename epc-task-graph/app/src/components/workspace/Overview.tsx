import { useMemo } from "react";
import { useApp, selectReadOnly } from "../../store/store";
import { useCpm } from "../../store/hooks";
import {
  deriveInsights,
  weightedProgress,
  shortDate,
} from "../../domain/insights";
import {
  DISC_LABEL,
  STATUS_LABEL,
  addCalendarDays,
  daysBetween,
  isStaleDataDate,
  todayIso,
  type ActiveView,
  type Task,
} from "../../domain";
import { Icon } from "./Icon";
import { API_MODE } from "../../storage/mode";
import { varianceClass, varianceLabel } from "../scheduleFormat";

const LIST_MAX = 3; // 要対応の各一覧に出す件数

export function Overview({
  onNavigate,
  onCreate,
}: {
  onNavigate: (view: ActiveView) => void;
  onCreate: () => void;
}) {
  const tasks = useApp((s) => s.tasks),
    deps = useApp((s) => s.dependencies),
    project = useApp((s) => s.project),
    readOnly = useApp(selectReadOnly);
  const cpm = useCpm();
  const today = todayIso();
  const data = useMemo(
    () =>
      deriveInsights(tasks, deps, cpm, { today, dataDate: project.dataDate }),
    [tasks, deps, cpm, today, project.dataDate],
  );
  // ベースラインの完了日（保存した計画の最終終了日）と、現在の計算上の完了との差。
  const baselineFinish = useMemo(
    () =>
      tasks.reduce(
        (m, t) =>
          t.baselineFinish && t.baselineFinish > m ? t.baselineFinish : m,
        "",
      ),
    [tasks],
  );
  const finishVar = baselineFinish
    ? daysBetween(baselineFinish, cpm.projectFinishDate)
    : null;
  const stale = isStaleDataDate(project.dataDate, today);
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
  // 要対応の小見出し付き一覧（先頭 LIST_MAX 件＋残件数）。
  const attentionGroup = (
    title: string,
    testId: string,
    items: { key: string; task: Task; note: string; late: boolean }[],
  ) =>
    items.length > 0 && (
      <div className="attention-group" data-testid={testId}>
        <div className="attention-group-title">
          {title}
          <span>{items.length}件</span>
        </div>
        {items.slice(0, LIST_MAX).map((it) => (
          <button
            className="attention-item compact"
            key={it.key}
            onClick={() => select(it.task)}
          >
            <span className={"attention-dot" + (it.late ? " late" : "")} />
            <span>
              <strong>{it.task.name}</strong>
              <small>{it.note}</small>
            </span>
          </button>
        ))}
        {items.length > LIST_MAX && (
          <div className="attention-more">
            他 {items.length - LIST_MAX} 件
          </div>
        )}
      </div>
    );
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
  // 工程の見通しの時間軸: [最早開始(minStart), 計算上の完了(projectEnd)]。完了タスクは基準日より前に置かれる。
  const timeline = (() => {
    const lo = Math.min(0, cpm.minStart),
      span = Math.max(1, cpm.projectEnd - lo);
    const pct = (off: number) =>
      Math.min(100, Math.max(0, ((off - lo) / span) * 100));
    const todayOff = daysBetween(project.dataDate, today);
    const todayPct =
      todayOff !== 0 && todayOff >= lo && todayOff <= cpm.projectEnd
        ? pct(todayOff)
        : null;
    const dataPct = pct(0);
    // 旗が重ならないよう、基準日と今日は互いに反対側へ出す（端では内側へ）。
    const dataLeft =
      (todayPct != null ? todayPct > dataPct : dataPct > 60) && dataPct > 15;
    const todayLeft =
      todayPct != null &&
      (todayPct < dataPct || todayPct > 85) &&
      todayPct > 15;
    return {
      pct,
      dataPct,
      todayPct,
      dataLeft,
      todayLeft,
      startDate: addCalendarDays(project.dataDate, lo),
    };
  })();
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
            {shortDate(cpm.projectFinishDate)}
            <span>{cpm.projectFinishDate.slice(0, 4)}</span>
          </div>
          <div className="metric-note">
            基準日から {cpm.projectEnd} 暦日 <Icon name="arrow" size={15} />
          </div>
          {finishVar != null && (
            <div className="metric-note baseline-note">
              ベースライン {shortDate(baselineFinish)}
              <b className={varianceClass(finishVar)}>
                {varianceLabel(finishVar)}
              </b>
            </div>
          )}
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
              <span className="eyebrow">工種別の日程</span>
              <h2>工程の見通し</h2>
            </div>
            <button className="text-button" onClick={() => onNavigate("gantt")}>
              ガントで開く
              <Icon name="arrow" size={16} />
            </button>
          </div>
          <div className="phase-timeline">
            {/* 目盛り行: 期間の両端と基準日／今日の旗（バーと同じ列幅で揃える） */}
            <div className="phase-row phase-scale-row" aria-hidden="true">
              <span className="phase-label" />
              <span className="phase-track phase-scale">
                <span className="phase-scale-start">
                  開始 {shortDate(timeline.startDate)}
                </span>
                <span className="phase-scale-end">
                  計算上の完了 {shortDate(cpm.projectFinishDate)}
                </span>
                <i
                  className="phase-marker data"
                  style={{ left: `${timeline.dataPct}%` }}
                />
                <span
                  className={
                    "phase-flag data" +
                    (timeline.dataLeft ? " to-left" : "")
                  }
                  style={{ left: `${timeline.dataPct}%` }}
                >
                  {timeline.todayPct == null && today === project.dataDate
                    ? "基準日＝今日"
                    : "基準日"}{" "}
                  {shortDate(project.dataDate)}
                </span>
                {timeline.todayPct != null && (
                  <>
                    <i
                      className="phase-marker now"
                      style={{ left: `${timeline.todayPct}%` }}
                    />
                    <span
                      className={
                        "phase-flag now" + (timeline.todayLeft ? " to-left" : "")
                      }
                      style={{ left: `${timeline.todayPct}%` }}
                    >
                      今日
                    </span>
                  </>
                )}
              </span>
              <span className="phase-percent" />
            </div>
            {data.groups.map((g) => {
              const results = g.tasks.flatMap(
                (t) => cpm.byTask.get(t.id) ?? [],
              );
              // 最早開始のタスクと最遅終了（EF 最大）のタスク。
              let first = results[0],
                last = results[0];
              for (const r of results) {
                if (r.es < first.es) first = r;
                if (r.ef > last.ef) last = r;
              }
              const l = first ? timeline.pct(first.es) : 0,
                w = first ? Math.max(2, timeline.pct(last.ef) - l) : 0;
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
                    {first && (
                      <i
                        className={"phase-bar " + g.discipline}
                        style={{
                          left: `${Math.max(0, Math.min(l, 100 - w))}%`,
                          width: `${Math.min(100, w)}%`,
                        }}
                      >
                        <span>
                          {shortDate(first.esDate)} —{" "}
                          {shortDate(last.finishDate)}
                        </span>
                      </i>
                    )}
                    <i
                      className="phase-marker data"
                      style={{ left: `${timeline.dataPct}%` }}
                    />
                    {timeline.todayPct != null && (
                      <i
                        className="phase-marker now"
                        style={{ left: `${timeline.todayPct}%` }}
                      />
                    )}
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
              <span className="eyebrow">主要な節目</span>
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
                  <time>{shortDate(cpm.byTask.get(t.id)?.finishDate)}</time>
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
              <span className="eyebrow">クリティカルパス</span>
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
                  {shortDate(cpm.byTask.get(t.id)?.finishDate)}
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
              <span className="eyebrow">要対応</span>
              <h2>確認しておきたいこと</h2>
            </div>
            <Icon name="alert" />
          </div>
          {stale && (
            <div className="attention-card stale" data-testid="stale-data-date">
              <strong>
                基準日（進捗の締め日）が {data.staleDays} 日前のままです
              </strong>
              <p>
                進捗（ステータス・実績日）を更新したら、基準日を今日に進めてください。着手済みの残作業は基準日から再計算されます。
              </p>
              {!readOnly && (
                <button
                  className="btn primary"
                  onClick={() => useApp.getState().setDataDate(today)}
                >
                  基準日を今日に更新
                </button>
              )}
            </div>
          )}
          {!data.hasBaseline && !readOnly && (
            <div className="attention-card baseline-cta">
              <p>
                ベースライン（現在の計画）を保存すると、計画からの遅れを日数で追跡できます。
              </p>
              <button
                className="btn"
                data-testid="overview-save-baseline"
                onClick={() => useApp.getState().setBaseline()}
              >
                ベースラインを保存
              </button>
            </div>
          )}
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
          {attentionGroup(
            "期限超過",
            "overdue-list",
            data.overdue.map((t) => {
              const r = cpm.byTask.get(t.id);
              return {
                key: t.id,
                task: t,
                note:
                  r && r.finishDate < today
                    ? `終了予定 ${shortDate(r.finishDate)} を経過`
                    : `開始予定 ${shortDate(r?.esDate)} を過ぎて未着手`,
                late: true,
              };
            }),
          )}
          {attentionGroup(
            "ベースライン比の遅れ",
            "slipped-list",
            data.slipped.map(({ task, days }) => ({
              key: task.id,
              task,
              note: `+${days}日`,
              late: true,
            })),
          )}
          {attentionGroup(
            "実績データの不整合",
            "data-issue-list",
            data.dataIssues.map(({ task, message }, i) => ({
              key: `${task.id}-${i}`,
              task,
              note: message,
              late: false,
            })),
          )}
          {!data.attention.length &&
            !data.overdue.length &&
            !data.slipped.length &&
            !data.dataIssues.length &&
            !stale && (
              <div className="attention-clear">
                <Icon name="check" size={26} />
                <strong>確認事項はありません</strong>
                <p>
                  保留・日付制約の超過・期限超過・ベースライン比の遅れ・実績の不整合をここで確認できます。
                </p>
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
          {API_MODE ? "サーバーに自動保存" : "このブラウザに自動保存"}
        </span>
      </footer>
    </div>
  );
}
