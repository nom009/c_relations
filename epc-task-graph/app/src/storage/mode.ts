// ビルド時に決まる保存先モード。VITE_STORAGE=api の時だけサーバー版（既定はローカル IndexedDB）。
// 定数なので、ローカル向けビルドではサーバー版専用の分岐は除去される。
export const API_MODE: boolean = import.meta.env.VITE_STORAGE === 'api';
export const API_BASE: string = (import.meta.env.VITE_API_BASE || '/api').replace(/\/+$/, '');
