// ============================================================================
// 一括操作バー（§12.3.5 PR-T2）: テーブルで2件以上選択中に表示。
// 削除／ステータス／担当／工種 を選択タスク全体へ適用（すべて既存/新設ストアアクション経由）。
// 1操作=1 Undo単位（bulkUpdateTasks は1回の set()）。§7.4の直接setState禁止に従う。
// ============================================================================
import { useState } from 'react';
import {
  DISCIPLINES,
  STATUSES,
  STATUS_LABEL,
  type Discipline,
  type Status,
} from '../../domain';
import { useApp } from '../../store/store';

export function BulkBar({ ids, assigneeOptions }: { ids: string[]; assigneeOptions: string[] }) {
  const [assignee, setAssignee] = useState('');
  const n = ids.length;

  const applyStatus = (v: string) => {
    if (v) useApp.getState().bulkUpdateTasks(ids, { status: v as Status });
  };
  const applyDiscipline = (v: string) => {
    if (v) useApp.getState().bulkUpdateTasks(ids, { discipline: v as Discipline });
  };
  const applyAssignee = () => {
    useApp.getState().bulkUpdateTasks(ids, { assignee: assignee.trim() });
    setAssignee('');
  };

  return (
    <span className="bulkbar" data-testid="bulkbar">
      <b className="bulk-count">{n}件選択</b>

      <button
        className="btn danger"
        title="選択タスクを一括削除（Cmd+Z で復元）"
        data-testid="bulk-delete"
        onClick={() => useApp.getState().deleteTasks(ids)}
      >
        削除
      </button>

      {/* select は「見出し（適用対象の型）」を先頭に置き、選ぶと即適用してリセット */}
      <select
        className="bulk-select"
        data-testid="bulk-status"
        value=""
        onChange={(e) => {
          applyStatus(e.target.value);
          e.currentTarget.value = '';
        }}
      >
        <option value="">ステータス…</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>

      <select
        className="bulk-select"
        data-testid="bulk-discipline"
        value=""
        onChange={(e) => {
          applyDiscipline(e.target.value);
          e.currentTarget.value = '';
        }}
      >
        <option value="">工種…</option>
        {DISCIPLINES.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>

      <input
        className="bulk-assignee"
        list="bulk-assignee-options"
        placeholder="担当を一括設定…"
        data-testid="bulk-assignee"
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') applyAssignee();
        }}
      />
      <datalist id="bulk-assignee-options">
        {assigneeOptions.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <button className="btn" data-testid="bulk-assignee-apply" onClick={applyAssignee} disabled={!assignee.trim()}>
        担当適用
      </button>
    </span>
  );
}
