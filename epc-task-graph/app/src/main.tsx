import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WriterLockOverlay } from "./components/WriterLockOverlay";
import { useApp, bootstrapStore, flushPersistence } from "./store/store";
import { acquireWriterLock, isWriterTab } from "./store/writerLock";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
// Hydrate before enabling edits, so stored project data cannot replace a newly edited screen.
root.render(
  <div className="app-loading" role="status">
    <span>C-Relations</span>
    <p>ワークスペースを開いています…</p>
  </div>,
);

// 再読込直後は旧ページのロック解放が少し遅れるため、案内は短い猶予を置いてから出す。
const OVERLAY_DELAY_MS = 300;

async function start() {
  // 別タブが書込ロックを持つ間は、読込も保存もせず待つ（解放されたらDBから読み直して起動する）。
  let overlayTimer: ReturnType<typeof setTimeout> | undefined;
  await acquireWriterLock(() => {
    overlayTimer = setTimeout(() => root.render(<WriterLockOverlay />), OVERLAY_DELAY_MS);
  });
  clearTimeout(overlayTimer);
  await bootstrapStore();
  // タブを隠す/閉じる時点でデバウンス待ちの差分を即書き出す（閉じた直後の編集を失わない）。
  const flushNow = () => {
    if (isWriterTab()) void flushPersistence().catch(() => undefined);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
  window.addEventListener("pagehide", flushNow);
  // 保存に失敗したままの離脱は確認する（書き出しの機会を残す）。
  window.addEventListener("beforeunload", (e) => {
    if (useApp.getState().saveStatus === "error") e.preventDefault();
  });
  if (import.meta.env.DEV || import.meta.env.VITE_E2E === "true")
    (window as unknown as { __APP: typeof useApp }).__APP = useApp;
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
void start();
