import { describe, it, expect } from 'vitest';
import { dateRange, signedDays, varianceClass, varianceLabel } from '../../src/components/scheduleFormat';

describe('scheduleFormat', () => {
  it('差異を符号付きで表示する（負号は U+2212）', () => {
    expect(signedDays(3)).toBe('+3');
    expect(signedDays(-2)).toBe('\u22122');
    expect(signedDays(0)).toBe('0');
  });

  it('差異の説明と色分け', () => {
    expect(varianceLabel(3)).toBe('+3日遅れ');
    expect(varianceLabel(-2)).toBe('2日前倒し');
    expect(varianceLabel(0)).toBe('差異なし');
    expect(varianceClass(1)).toBe('var-late');
    expect(varianceClass(-1)).toBe('var-early');
    expect(varianceClass(0)).toBe('');
    expect(varianceClass(null)).toBe('');
  });

  it('日付範囲は欠けた側を — で示す', () => {
    expect(dateRange('2025-06-02', '2025-06-04')).toBe('2025-06-02 〜 2025-06-04');
    expect(dateRange('2025-06-02', null)).toBe('2025-06-02 〜 —');
    expect(dateRange(null, undefined)).toBe('—');
  });
});
