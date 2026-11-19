import { useRef, useState } from "react";
import { Dialog } from "./Dialog";

// クリップボード API が使えない環境（非 https 等）向け。モーダル外は操作不能なので、ダイアログ内に一時配置する。
function fallbackCopy(text: string, host: HTMLElement | null): boolean {
  if (!host) return false;
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  host.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  host.removeChild(ta);
  prev?.focus();
  return ok;
}

// メッセージ一覧ダイアログ（取込エラー・注意など）。コピーして修正作業に使える。
export function MessageListDialog({
  title,
  lead,
  messages,
  onClose,
  testId = "message-list-dialog",
}: {
  title: string;
  lead?: string;
  messages: string[];
  onClose: () => void;
  testId?: string;
}) {
  const [copied, setCopied] = useState<"ok" | "ng" | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const copy = async () => {
    const text = messages.join("\n");
    let ok: boolean;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = fallbackCopy(text, bodyRef.current);
    }
    setCopied(ok ? "ok" : "ng");
  };
  return (
    <Dialog title={title} subtitle={lead} onClose={onClose} className="message-list-dialog">
      <div className="dialog-body" ref={bodyRef} data-testid={testId}>
        <p className="message-list-count">{messages.length} 件</p>
        <ul className="message-list">
          {messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </div>
      <div className="dialog-footer">
        {copied ? (
          <span className="message-list-copied" role="status">
            {copied === "ok" ? "コピーしました" : "コピーできませんでした"}
          </span>
        ) : null}
        <button type="button" className="btn" onClick={() => void copy()}>
          コピー
        </button>
        <button type="button" className="btn primary" data-autofocus onClick={onClose}>
          閉じる
        </button>
      </div>
    </Dialog>
  );
}
