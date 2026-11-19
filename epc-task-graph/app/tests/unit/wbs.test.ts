import { describe, it, expect } from 'vitest';
import { wbsCodesWithAncestors, wbsLabel, wbsNameOf } from '../../src/domain';

describe('WBS 名称ヘルパー', () => {
  it('wbsLabel: 名称があれば「コード 名称」、無ければコードのみ', () => {
    const names = { '1': '設計', '1.2': '  配管設計 ', '2': '   ' };
    expect(wbsLabel('1.2', names)).toBe('1.2 配管設計');
    expect(wbsLabel('1', names)).toBe('1 設計');
    expect(wbsLabel('2', names)).toBe('2'); // 空白のみは名称なし
    expect(wbsLabel('3', names)).toBe('3');
    expect(wbsLabel('1.2')).toBe('1.2');
  });

  it('wbsNameOf: プロトタイプのキーを名称として拾わない', () => {
    expect(wbsNameOf('constructor', {})).toBe('');
    expect(wbsNameOf('toString', { '1': 'x' })).toBe('');
  });

  it('wbsCodesWithAncestors: 祖先を補い、重複なく自然順（1.10 は 1.9 の後）', () => {
    expect(wbsCodesWithAncestors(['1.2.3', '1.10', '1.9', '', '2', '1.2'])).toEqual([
      '1',
      '1.2',
      '1.2.3',
      '1.9',
      '1.10',
      '2',
    ]);
    expect(wbsCodesWithAncestors([])).toEqual([]);
  });
});
