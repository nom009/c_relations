// ビュー別キーボードショートカットの共通ガード。
const EDITABLE = 'input,textarea,select,[contenteditable=""],[contenteditable="true"],dialog';
const ACTIVATABLE = 'button,a[href],summary,[role="tab"],[role="menuitem"]';

// 修飾キーの表記をOSに合わせる（Mac=⌘ / Windows等=Ctrl）。判定は表示専用で、処理は両方受け付ける。
function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = uaData?.platform || navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}
export const IS_MAC = detectMac();
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';
/** 例: modKey('Z') → Mac「⌘Z」/ その他「Ctrl+Z」 */
export const modKey = (key: string) => (IS_MAC ? MOD_LABEL + key : MOD_LABEL + '+' + key);
/** 例: modShiftKey('Z') → Mac「⇧⌘Z」/ その他「Ctrl+Shift+Z」 */
export const modShiftKey = (key: string) => (IS_MAC ? '⇧' + MOD_LABEL + key : MOD_LABEL + '+Shift+' + key);

// モーダル表示中・入力中は処理しない。ボタン等にフォーカスがある時は Tab/Enter/Space の
// ネイティブ操作（フォーカス移動・押下）を優先する。
export function isShortcutBlocked(e: KeyboardEvent): boolean {
  if (document.querySelector('dialog[open]')) return true;
  const el = e.target instanceof Element ? e.target : null;
  if (!el) return false;
  if (el.closest(EDITABLE) || (el instanceof HTMLElement && el.isContentEditable)) return true;
  return (e.key === 'Tab' || e.key === 'Enter' || e.key === ' ') && el.closest(ACTIVATABLE) !== null;
}
