import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App";
import { useApp, bootstrapStore, flushPersistence } from "./store/store";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
// Hydrate before enabling edits, so stored project data cannot replace a newly edited screen.
root.render(
  <div className="app-loading" role="status">
    <span>C-Relations</span>
    <p>ワークスペースを開いています…</p>
  </div>,
);
void bootstrapStore().then(() => {
  // タブを隠す/閉じる時点でデバウンス待ちの差分を即書き出す（閉じた直後の編集を失わない）。
  const flushNow = () => void flushPersistence().catch(() => undefined);
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
      <App />
    </StrictMode>,
  );
});
