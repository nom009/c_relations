import type { ActiveView } from '../domain';
import type { IconName } from './workspace/Icon';

// 作業ビューの並び・名称・切替キー。サイドバーとビュー切替タブで共有し、順序と表記を揃える。
export const VIEW_NAV: { id: ActiveView; label: string; icon: IconName; key: string }[] = [
  { id: 'graph', label: '依存関係', icon: 'graph', key: 'G' },
  { id: 'gantt', label: 'ガントチャート', icon: 'gantt', key: 'Y' },
  { id: 'table', label: 'タスク一覧', icon: 'table', key: 'T' },
];
