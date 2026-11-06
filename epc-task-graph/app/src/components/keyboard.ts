// ビュー別キーボードショートカットの共通ガード。
const EDITABLE = 'input,textarea,select,[contenteditable=""],[contenteditable="true"],dialog';
const ACTIVATABLE = 'button,a[href],summary,[role="tab"],[role="menuitem"]';

// モーダル表示中・入力中は処理しない。ボタン等にフォーカスがある時は Tab/Enter/Space の
// ネイティブ操作（フォーカス移動・押下）を優先する。
export function isShortcutBlocked(e: KeyboardEvent): boolean {
  if (document.querySelector('dialog[open]')) return true;
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return false;
  if (el.closest(EDITABLE) || (el instanceof HTMLElement && el.isContentEditable)) return true;
  return (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ') && el.closest(ACTIVATABLE) !== null;
}
