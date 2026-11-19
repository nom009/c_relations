import { Dialog } from "./workspace/Dialog";
// ============================================================================
// 検索パレット（§2.6・Phase1 PR5-8）: Cmd/Ctrl+K で開き、名前/WBS/担当でタスクを絞り込み、
// Enter で「移動」＝revealTask（祖先WBS展開＋選択）。全ビュー共通（選択同期でテーブル/ガントも追従、
// グラフはセンタリング）。4,000件でも各キーストロークの絞り込みは O(N) で軽量。
// ============================================================================
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store/store";
import { DISC_COLOR, wbsLabel, wbsNameOf, wbsPath, type Task } from "../domain";

export function SearchPalette({ onPick }: { onPick?: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const tasks = useApp((s) => s.tasks);
  const wbsNames = useApp((s) => s.project.wbsNames);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]") && !open) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQ("");
        setActive(0);
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // WBS 名称（祖先を含む）も検索対象にする。コードごとにキャッシュ。
  const wbsNamesHay = useMemo(() => {
    const cache = new Map<string, string>();
    return (code: string): string => {
      let v = cache.get(code);
      if (v === undefined) {
        v = wbsPath(code)
          .map((p) => wbsNameOf(p, wbsNames))
          .filter(Boolean)
          .join(" ");
        cache.set(code, v);
      }
      return v;
    };
  }, [wbsNames]);

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return tasks.slice(0, 8);
    const out: Task[] = [];
    for (const t of tasks) {
      const hay = (
        t.name +
        " " +
        t.wbsCode +
        " " +
        wbsNamesHay(t.wbsCode) +
        " " +
        t.assignee
      ).toLowerCase();
      if (hay.includes(s)) {
        out.push(t);
        if (out.length >= 20) break;
      }
    }
    return out;
  }, [q, tasks, wbsNamesHay]);

  if (!open) return null;

  const pick = (id: string) => {
    const s = useApp.getState();
    s.clearFocus();
    s.clearFilter();
    s.revealTask(id); // 祖先WBS展開＋選択（テーブル/ガントは選択同期で追従）
    setOpen(false);
    onPick?.();
    setTimeout(() => s.runners.centerSelected?.(), 40); // グラフはセンタリング
  };

  return (
    <Dialog
      title="タスクを検索"
      subtitle="名前・WBS・担当部署で探す"
      onClose={() => setOpen(false)}
      className="search-dialog"
    >
      <div className="search-box">
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls="task-search-results"
          aria-activedescendant={
            results[active] ? `search-${results[active].id}` : undefined
          }
          aria-label="名前・WBS・担当部署で検索"
          autoComplete="off"
          ref={inputRef}
          className="search-input"
          placeholder="検索するタスクを入力…"
          value={q}
          data-testid="search-input"
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) =>
                Math.max(0, Math.min(results.length - 1, a + 1)),
              );
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const t = results[active];
              if (t) pick(t.id);
            }
          }}
        />
        <div
          id="task-search-results"
          role="listbox"
          className="search-results"
          data-testid="search-results"
        >
          {results.length ? (
            results.map((t, i) => (
              <div
                role="option"
                id={`search-${t.id}`}
                aria-selected={i === active}
                key={t.id}
                className={"search-item" + (i === active ? " active" : "")}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(t.id)}
              >
                <span
                  className="disc-dot"
                  style={{ background: DISC_COLOR[t.discipline] }}
                />
                <span
                  className="mono"
                  title={
                    wbsNamesHay(t.wbsCode)
                      ? wbsPath(t.wbsCode)
                          .map((p) => wbsLabel(p, wbsNames))
                          .join(" › ")
                      : undefined
                  }
                >
                  {t.wbsCode || "—"}
                </span>
                <span className="s-name">{t.name || "（無題）"}</span>
                <span className="s-assignee">{t.assignee}</span>
              </div>
            ))
          ) : (
            <div className="search-empty">
              {q ? "該当なし" : "名前・WBS・担当で検索"}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
