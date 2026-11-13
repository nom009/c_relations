// ビルド時に決まる保存先モード。VITE_STORAGE=api の時だけサーバー版（既定はローカル IndexedDB）。
// 定数なので、ローカル向けビルドではサーバー版専用の分岐は除去される。
export const API_MODE: boolean = import.meta.env.VITE_STORAGE === 'api';
// 公開デモ（GitHub Pages）向けビルドの印。本番（サーバー版）と取り違えないよう画面に明示する。
export const DEMO_MODE: boolean = !API_MODE && import.meta.env.VITE_DEMO === 'true';
export const API_BASE: string = (import.meta.env.VITE_API_BASE || '/api').replace(/\/+$/, '');
