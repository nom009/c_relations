/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'api' でサーバー版（ApiRepository）。未設定はローカル（IndexedDB）。ビルド時に決まる。 */
  readonly VITE_STORAGE?: string;
  /** サーバー版の API ベースパス（既定 '/api'）。 */
  readonly VITE_API_BASE?: string;
  readonly VITE_E2E?: string;
}
