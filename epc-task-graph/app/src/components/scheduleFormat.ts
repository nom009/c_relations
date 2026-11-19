// 進捗スケジュールの表示用文字列（差異・日付範囲）。UI 非依存の純関数。

/** 符号付き日数（"+3" ／ "−2" ／ "0"）。負号は U+2212（マイナス記号）。 */
export function signedDays(v: number): string {
  if (v > 0) return '+' + v;
  if (v < 0) return '\u2212' + Math.abs(v);
  return '0';
}

/** ベースライン差の説明（"+3日遅れ" ／ "2日前倒し" ／ "差異なし"）。 */
export function varianceLabel(v: number): string {
  if (v > 0) return `+${v}日遅れ`;
  if (v < 0) return `${Math.abs(v)}日前倒し`;
  return '差異なし';
}

/** 差異の色分けクラス（table.css の var-late ／ var-early）。 */
export function varianceClass(v: number | null | undefined): string {
  if (v == null || v === 0) return '';
  return v > 0 ? 'var-late' : 'var-early';
}

/** "開始〜終了"。片方だけでも表示し、両方無ければ "—"。 */
export function dateRange(start?: string | null, finish?: string | null): string {
  if (!start && !finish) return '—';
  return `${start || '—'} 〜 ${finish || '—'}`;
}
