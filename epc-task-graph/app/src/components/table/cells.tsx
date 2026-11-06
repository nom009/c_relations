// ============================================================================
// テーブルのセル部品と列メタ（§12.3.2）。presentational のみ。仮想化ライブラリ非依存。
// ============================================================================
import {
  DISC_COLOR_ON,
  STATUS_LABEL,
  type Discipline,
  type Status,
  type TableColumnKey,
} from '../../domain';

export const ROW_HEIGHT = 44; // 固定行高（§12.3.3。ガント左右ペインと共有する定数）。

export interface ColumnMeta {
  label: string;
  width: number;
  align?: 'left' | 'right' | 'center';
  sortable: boolean;
  numeric?: boolean;
}

// 正準列メタ（ラベル/幅/整列/ソート可否）。表示順は store.ALL_TABLE_COLUMNS が持つ。
export const COLUMN_META: Record<TableColumnKey, ColumnMeta> = {
  wbsCode: { label: 'WBS', width: 96, sortable: true },
  name: { label: 'タスク名', width: 280, sortable: true },
  wbsPath: { label: 'WBSパス', width: 180, sortable: true },
  discipline: { label: '工種', width: 60, align: 'center', sortable: true },
  assignee: { label: '担当', width: 120, sortable: true },
  status: { label: 'ステータス', width: 96, align: 'center', sortable: true },
  progress: { label: '進捗', width: 96, sortable: true, numeric: true },
  durationDays: { label: '日数', width: 64, align: 'right', sortable: true, numeric: true },
  es: { label: '開始予定', width: 104, align: 'center', sortable: true, numeric: true },
  ef: { label: '終了予定', width: 104, align: 'center', sortable: true, numeric: true },
  ls: { label: '最遅開始', width: 104, align: 'center', sortable: true, numeric: true },
  lf: { label: '最遅終了', width: 104, align: 'center', sortable: true, numeric: true },
  totalFloat: { label: '余裕日数', width: 90, align: 'right', sortable: true, numeric: true },
  critical: { label: 'CP', width: 44, align: 'center', sortable: true },
  deps: { label: '先行/後続', width: 96, align: 'center', sortable: false },
};

export const EDITABLE_COLUMNS: TableColumnKey[] = [
  'wbsCode',
  'name',
  'discipline',
  'assignee',
  'status',
  'progress',
  'durationDays',
];

// チップは白文字が乗るため WCAG AA 安全版の工種色（DISC_COLOR_ON）を使う。
export function DiscChip({ d }: { d: Discipline }) {
  return (
    <span className="disc-chip" style={{ background: DISC_COLOR_ON[d] }} title={d}>
      {d}
    </span>
  );
}

export function StatusBadge({ s }: { s: Status }) {
  return <span className={'st-badge st-' + s}>{STATUS_LABEL[s]}</span>;
}

export function ProgressBar({ v }: { v: number }) {
  const pct = Math.max(0, Math.min(100, v));
  return (
    <span className="tprogress" title={pct + '%'}>
      <span className="tprogress-bar">
        <i style={{ width: pct + '%' }} />
      </span>
      <span className="tprogress-num">{pct}</span>
    </span>
  );
}
