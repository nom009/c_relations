import { useMemo, useState } from "react";
import { useApp, selectActiveCalendar } from "../store/store";
import { useAssigneeOptions, useCpm, useSelectedTask } from "../store/hooks";
import { selectTaskIndex } from "../store/selectors";
import {
  computeCpm,
  DISCIPLINES,
  STATUSES,
  DISC_LABEL,
  STATUS_LABEL,
  type Dependency,
  type Task,
} from "../domain";
import { shortDate } from "../domain/insights";
import { Icon } from "./workspace/Icon";
import { Dialog } from "./workspace/Dialog";

function DepAdder({
  label,
  exclude,
  onPick,
}: {
  label: string;
  exclude: Set<string>;
  onPick: (id: string) => boolean;
}) {
  const tasks = useApp((s) => s.tasks),
    [q, setQ] = useState("");
  const results = useMemo(
    () =>
      q.trim()
        ? tasks
            .filter(
              (t) =>
                !exclude.has(t.id) &&
                `${t.name} ${t.wbsCode}`
                  .toLowerCase()
                  .includes(q.trim().toLowerCase()),
            )
            .slice(0, 8)
        : [],
    [q, tasks, exclude],
  );
  return (
    <div className="depadder">
      <input
        className="depadder-input"
        aria-label={label}
        placeholder={label}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {q.trim() && (
        <div className="depadder-list">
          {results.map((t) => (
            <button
              key={t.id}
              className="depadder-item"
              onClick={() => {
                if (onPick(t.id)) setQ("");
              }}
            >
              <span className="mono">{t.wbsCode || "—"}</span>
              {t.name}
            </button>
          ))}
          {!results.length && (
            <p className="dep-empty">該当するタスクがありません</p>
          )}
        </div>
      )}
    </div>
  );
}
// 打鍵ごとに更新すると 1 文字ごとに履歴・保存・CPM 再計算（WBS ならツリー再構築）が走るため、
// 入力中は下書きに留めて blur/Enter で確定する（Esc で破棄）。Undo 等の外部変更は下書きへ反映する。
function DraftField({
  value,
  onCommit,
  accept,
  multiline,
  rows,
  list,
  type,
  ...attrs
}: {
  value: string;
  onCommit: (v: string) => void;
  accept?: (v: string) => boolean;
  multiline?: boolean;
  rows?: number;
  list?: string;
  className?: string;
  type?: "text" | "number";
  placeholder?: string;
  maxLength?: number;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState(value),
    [base, setBase] = useState(value);
  if (base !== value) {
    setBase(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft === value) return;
    if (accept && !accept(draft)) setDraft(value);
    else onCommit(draft);
  };
  const common = {
    ...attrs,
    value: draft,
    onBlur: commit,
  };
  return multiline ? (
    <textarea
      {...common}
      rows={rows}
      onChange={(e) => setDraft(e.target.value)}
    />
  ) : (
    <input
      {...common}
      type={type}
      list={list}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}
const isLagDays = (v: string) =>
  /^-?\d+$/.test(v) && Math.abs(Number(v)) <= 36500;

function DurationEditor({ task }: { task: Task }) {
  const tasks = useApp((s) => s.tasks),
    deps = useApp((s) => s.dependencies),
    date = useApp((s) => s.project.dataDate),
    calendar = useApp(selectActiveCalendar),
    current = useCpm();
  const [draft, setDraft] = useState(String(task.durationDays));
  const days = Number(draft),
    valid =
      draft !== "" && Number.isInteger(days) && days >= 0 && days <= 10000,
    changed = valid && days !== task.durationDays && !task.isMilestone;
  const forecast = useMemo(
    () =>
      changed
        ? computeCpm(
            tasks.map((t) =>
              t.id === task.id ? { ...t, durationDays: days } : t,
            ),
            deps,
            date,
            calendar,
          )
        : null,
    [changed, days, tasks, deps, date, calendar, task.id],
  );
  const delta = forecast ? forecast.projectEnd - current.projectEnd : 0;
  return (
    <div className="duration-editor">
      <label className="form-field">
        所要日数（稼働日）
        <div className="duration-control">
          <input
            type="number"
            min={0}
            max={10000}
            step={1}
            value={task.isMilestone ? 0 : draft}
            disabled={task.isMilestone}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="所要日数"
          />
          <span>日</span>
        </div>
      </label>
      {!valid && (
        <p className="form-error">0〜10,000の整数を入力してください。</p>
      )}
      {changed && forecast && (
        <div
          className={"impact-preview " + (delta > 0 ? "later" : "")}
          role="status"
        >
          <div>
            <Icon name="clock" />
            <strong>プロジェクト完了日への影響</strong>
          </div>
          <p>
            {shortDate(current.projectEndDate)}
            <Icon name="arrow" size={14} />
            <b>{shortDate(forecast.projectEndDate)}</b>
            <span>
              {delta > 0
                ? `+${delta}日`
                : delta < 0
                  ? `${delta}日`
                  : "変更なし"}
            </span>
          </p>
          <small>変更を適用するまで、工程は更新されません。</small>
          <div className="impact-actions">
            <button
              className="btn"
              onClick={() => setDraft(String(task.durationDays))}
            >
              元に戻す
            </button>
            <button
              className="btn primary"
              onClick={() => {
                useApp.getState().updateTask(task.id, { durationDays: days });
                useApp
                  .getState()
                  .showToast(`所要日数を${days}日に更新しました`);
              }}
            >
              変更を適用
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
export function RightPanel() {
  const task = useSelectedTask(),
    tasks = useApp((s) => s.tasks),
    deps = useApp((s) => s.dependencies),
    cpm = useCpm(),
    assigneeOptions = useAssigneeOptions();
  const [tab, setTab] = useState<"details" | "relations" | "schedule">(
      "details",
    ),
    [confirmDelete, setConfirmDelete] = useState(false);
  if (!task) return null;
  const upd = (patch: Partial<Task>) =>
      useApp.getState().updateTask(task.id, patch),
    preds = deps.filter((d) => d.successorId === task.id),
    succs = deps.filter((d) => d.predecessorId === task.id),
    byId = selectTaskIndex(tasks),
    schedule = cpm.byTask.get(task.id);
  const depItem = (d: Dependency, otherId: string) => (
    <div className="relation-item" key={d.id}>
      <button
        className="relation-name"
        onClick={() => useApp.getState().revealTask(otherId)}
      >
        <span
          className={
            "task-square " + (byId.get(otherId)?.discipline || "OTHER")
          }
        />
        {byId.get(otherId)?.name || "タスク"}
        <Icon name="chevron" size={14} />
      </button>
      <div className="relation-controls">
        <select
          aria-label="依存タイプ"
          className="deptype"
          value={d.type}
          onChange={(e) =>
            useApp
              .getState()
              .updateDep(d.id, { type: e.target.value as Dependency["type"] })
          }
        >
          <option value="FS">完了 → 開始（FS）</option>
          <option value="SS">開始 → 開始（SS）</option>
          <option value="FF">完了 → 完了（FF）</option>
          <option value="SF">開始 → 完了（SF）</option>
        </select>
        <label>
          間隔
          <DraftField
            className="deplag"
            aria-label="ラグ日数"
            type="number"
            value={String(d.lagDays)}
            accept={isLagDays}
            onCommit={(v) =>
              useApp.getState().updateDep(d.id, { lagDays: Number(v) })
            }
          />
          日
        </label>
        <button
          className="icon-button"
          aria-label="依存関係を削除"
          title="接続を削除（取り消し可能）"
          onClick={() => {
            useApp.getState().deleteDeps([d.id]);
            useApp
              .getState()
              .showToast("接続を削除しました。取り消しで戻せます");
          }}
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </div>
  );
  return (
    <div className="panel right redesigned-inspector">
      <div className="inspector-title">
        <span className={"disc-letter " + task.discipline}>
          {task.discipline}
        </span>
        <span>
          {DISC_LABEL[task.discipline]}
          <small>{task.wbsCode || "WBS未設定"}</small>
        </span>
        {schedule?.isCritical && (
          <span className="critical-label">クリティカル</span>
        )}
      </div>
      <h2>{task.name || "名称未設定"}</h2>
      <div
        className="inspector-tabs"
        role="tablist"
        aria-label="タスク詳細の表示"
      >
        {(
          [
            ["details", "基本情報"],
            ["relations", `つながり ${preds.length + succs.length}`],
            ["schedule", "日程"],
          ] as const
        ).map(([id, label]) => (
          <button
            role="tab"
            key={id}
            aria-selected={tab === id}
            aria-controls={"inspector-" + id}
            id={"inspector-tab-" + id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={"inspector-" + tab}
        aria-labelledby={"inspector-tab-" + tab}
      >
        {tab === "details" && (
          <>
            <label className="form-field">
              タスク名
              <DraftField
                value={task.name}
                maxLength={160}
                onCommit={(v) => upd({ name: v })}
              />
            </label>
            <div className="form-grid">
              <label className="form-field">
                ステータス
                <select
                  value={task.status}
                  onChange={(e) =>
                    upd({ status: e.target.value as Task["status"] })
                  }
                >
                  {STATUSES.map((s) => (
                    <option value={s} key={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-field">
                工種
                <select
                  value={task.discipline}
                  onChange={(e) =>
                    upd({ discipline: e.target.value as Task["discipline"] })
                  }
                >
                  {DISCIPLINES.map((d) => (
                    <option value={d} key={d}>
                      {DISC_LABEL[d]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="form-field">
              進捗
              <span className="progress-control">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={task.progress}
                  onChange={(e) => upd({ progress: Number(e.target.value) })}
                />
                <output>{task.progress}%</output>
              </span>
            </label>
            <DurationEditor
              key={`${task.id}-${task.durationDays}`}
              task={task}
            />
            <label className="form-field">
              担当部署
              <DraftField
                value={task.assignee}
                onCommit={(v) => upd({ assignee: v })}
                placeholder="担当を設定"
                list="inspector-assignees"
              />
              <datalist id="inspector-assignees">
                {assigneeOptions.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>
            <label className="form-field">
              WBSコード
              <DraftField
                value={task.wbsCode}
                onCommit={(v) => upd({ wbsCode: v.trim() })}
                placeholder="例：1.1"
              />
            </label>
            <label className="form-checkbox">
              <input
                type="checkbox"
                checked={task.isMilestone}
                onChange={(e) =>
                  upd({
                    isMilestone: e.target.checked,
                    durationDays: e.target.checked ? 0 : 5,
                  })
                }
              />
              マイルストーン
            </label>
            <label className="form-field">
              メモ
              <DraftField
                multiline
                rows={4}
                value={task.notes}
                onCommit={(v) => upd({ notes: v })}
                placeholder="確認事項や、次に取るアクションを記録"
              />
            </label>
          </>
        )}
        {tab === "relations" && (
          <>
            <div className="relation-heading">
              <h3>先行タスク</h3>
              <span>{preds.length}件</span>
            </div>
            {preds.length ? (
              preds.map((d) => depItem(d, d.predecessorId))
            ) : (
              <p className="dep-empty">先行タスクはありません</p>
            )}
            <DepAdder
              label="先行を追加（名前 / WBSで検索）"
              exclude={new Set([task.id, ...preds.map((d) => d.predecessorId)])}
              onPick={(id) =>
                useApp.getState().addDependencyChecked(id, task.id)
              }
            />
            <div className="relation-heading">
              <h3>後続タスク</h3>
              <span>{succs.length}件</span>
            </div>
            {succs.length ? (
              succs.map((d) => depItem(d, d.successorId))
            ) : (
              <p className="dep-empty">後続タスクはありません</p>
            )}
            <DepAdder
              label="後続を追加（名前 / WBSで検索）"
              exclude={new Set([task.id, ...succs.map((d) => d.successorId)])}
              onPick={(id) =>
                useApp.getState().addDependencyChecked(task.id, id)
              }
            />
            <button
              className="btn relation-focus"
              onClick={() => {
                useApp.getState().setActiveView("graph");
                useApp.getState().toggleFocus(task.id);
              }}
            >
              <Icon name="graph" />
              このタスクの前後を見る
            </button>
            <p className="inspector-help">
              接続を追加すると日程が再計算されます。循環する依存関係は作成できません。
            </p>
          </>
        )}
        {tab === "schedule" && (
          <>
            <div className="schedule-cards">
              <div data-testid="cpm-es" data-offset={schedule?.es}>
                <span>開始予定</span>
                <b>{schedule?.esDate || "—"}</b>
              </div>
              <div data-testid="cpm-ef" data-offset={schedule?.ef}>
                <span>終了予定</span>
                <b>{schedule?.efDate || "—"}</b>
              </div>
            </div>
            <div
              className={
                "float-card " + (schedule?.isCritical ? "critical" : "")
              }
            >
              <span>余裕日数</span>
              <b>
                {schedule?.totalFloat ?? "—"}
                <small>日</small>
              </b>
              <p>
                {schedule?.isCritical
                  ? "この工程の延長は、プロジェクト完了日に影響する可能性があります。"
                  : "この工程の開始を遅らせられる暦日数です。"}
              </p>
            </div>
            <DurationEditor
              key={`${task.id}-${task.durationDays}`}
              task={task}
            />
            <label className="form-field">
              日付制約
              <select
                data-testid="constraint-type"
                value={task.constraintType}
                onChange={(e) => {
                  const ct = e.target.value as Task["constraintType"];
                  upd({
                    constraintType: ct,
                    constraintDate: ct === "ASAP" ? null : task.constraintDate,
                  });
                }}
              >
                <option value="ASAP">できるだけ早く開始</option>
                <option value="SNET">指定日以降に開始</option>
                <option value="FNLT">指定日までに終了</option>
              </select>
            </label>
            {task.constraintType !== "ASAP" && (
              <label className="form-field">
                制約日
                <input
                  data-testid="constraint-date"
                  type="date"
                  value={task.constraintDate || ""}
                  onChange={(e) =>
                    upd({ constraintDate: e.target.value || null })
                  }
                />
              </label>
            )}
            <details className="form-details">
              <summary>計算の詳細</summary>
              <dl className="schedule-detail">
                <dt>最遅開始</dt>
                <dd>{schedule?.lsDate || "—"}</dd>
                <dt>最遅終了</dt>
                <dd>{schedule?.lfDate || "—"}</dd>
              </dl>
              <p className="inspector-help">
                稼働曜日・祝日はプロジェクト設定で変更できます。開始・終了は依存関係と所要日数から計算します。
              </p>
            </details>
          </>
        )}
      </div>
      <footer className="inspector-footer">
        <span>更新：{task.updatedBy}</span>
        <button
          className="text-button delete-task"
          onClick={() => setConfirmDelete(true)}
        >
          タスクを削除
        </button>
      </footer>
      {confirmDelete && (
        <Dialog
          title="タスクを削除しますか？"
          onClose={() => setConfirmDelete(false)}
        >
          <div className="dialog-body">
            <p>
              「{task.name}
              」と、接続されている依存関係を削除します。取り消しで元に戻せます。
            </p>
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={() => setConfirmDelete(false)}>
              キャンセル
            </button>
            <button
              className="btn danger"
              onClick={() => {
                useApp.getState().deleteTasks([task.id]);
                useApp
                  .getState()
                  .showToast("タスクを削除しました。取り消しで戻せます");
                setConfirmDelete(false);
              }}
            >
              削除する
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
