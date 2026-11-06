import { useState } from "react";
import { useApp } from "../../store/store";
import { useAssigneeOptions } from "../../store/hooks";
import { DISC_LABEL, type Discipline } from "../../domain";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
export function TaskDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const tasks = useApp((s) => s.tasks),
    me = useApp((s) => s.me),
    assigneeOptions = useAssigneeOptions();
  const [name, setName] = useState(""),
    [discipline, setDiscipline] = useState<Discipline>("E"),
    [days, setDays] = useState("5"),
    [assignee, setAssignee] = useState(""),
    [wbs, setWbs] = useState(""),
    [milestone, setMilestone] = useState(false),
    [predecessor, setPredecessor] = useState("");
  return (
    <Dialog
      title="タスクを追加"
      subtitle="工程を登録して、前後のつながりをつくります。"
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const s = useApp.getState();
          s.clearFilter();
          s.clearFocus();
          const t = s.addTask(
            {
              name: name.trim(),
              discipline,
              durationDays: milestone ? 0 : Number(days),
              isMilestone: milestone,
              assignee: assignee.trim(),
              wbsCode: wbs.trim(),
              position: { x: tasks.length * 70, y: 100 },
            },
            { edit: false },
          );
          if (predecessor) s.addDependencyChecked(predecessor, t.id);
          s.revealTask(t.id);
          s.showToast(`「${t.name}」を追加しました`);
          onCreated();
          onClose();
        }}
      >
        <div className="dialog-body">
          <label className="form-field">
            タスク名 <span className="required">必須</span>
            <input
              data-autofocus
              required
              maxLength={160}
              placeholder="例：主要機器の仕様を確定する"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="form-grid">
            <label className="form-field">
              工種
              <select
                value={discipline}
                onChange={(e) => setDiscipline(e.target.value as Discipline)}
              >
                {Object.entries(DISC_LABEL).map(([v, l]) => (
                  <option value={v} key={v}>
                    {v} · {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              所要日数（稼働日）
              <input
                type="number"
                min="0"
                max="10000"
                step="1"
                required
                disabled={milestone}
                value={milestone ? "0" : days}
                onChange={(e) => setDays(e.target.value)}
              />
            </label>
            <label className="form-field">
              担当
              <input
                list="task-assignees"
                placeholder={me || "担当部署"}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              />
              <datalist id="task-assignees">
                {assigneeOptions.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>
            <label className="form-field">
              WBSコード
              <input
                placeholder="例：1.1"
                value={wbs}
                onChange={(e) => setWbs(e.target.value)}
              />
            </label>
          </div>
          <label className="form-checkbox">
            <input
              type="checkbox"
              checked={milestone}
              onChange={(e) => setMilestone(e.target.checked)}
            />
            マイルストーンとして登録する
          </label>
          <details className="form-details">
            <summary>先行タスクをつなぐ（任意）</summary>
            <label className="form-field">
              このタスクの開始前に完了するタスク
              <select
                value={predecessor}
                onChange={(e) => setPredecessor(e.target.value)}
              >
                <option value="">指定しない</option>
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.wbsCode} · {t.name}
                  </option>
                ))}
              </select>
            </label>
          </details>
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn primary" type="submit" disabled={!name.trim()}>
            <Icon name="plus" />
            タスクを追加
          </button>
        </div>
      </form>
    </Dialog>
  );
}
