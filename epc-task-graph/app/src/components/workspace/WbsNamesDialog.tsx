// WBS 名称の編集（ProjectMeta.wbsNames）。タスクの WBS コード（祖先を含む）と、名称だけ残った未使用コードを一覧し、
// 変更した分だけを最新の名称へ重ねて一括保存する（1 回の「戻す」）。
import { useMemo, useState } from "react";
import { useApp, selectReadOnly } from "../../store/store";
import {
  WBS_CODE_MAX,
  WBS_NAME_MAX,
  WBS_NAMES_MAX,
  naturalWbsCompare,
  wbsCodesWithAncestors,
  wbsNameOf,
} from "../../domain";
import { Dialog } from "./Dialog";

interface Row {
  code: string;
  unused: boolean; // 名称はあるがタスクで使われていないコード
}

export function WbsNamesDialog({ onClose }: { onClose: () => void }) {
  const tasks = useApp((s) => s.tasks);
  const names = useApp((s) => s.project.wbsNames);
  const readOnly = useApp(selectReadOnly);
  // 開いた時点の名称（変更判定の基準）。行の並びもこれで固定し、編集中に行が消えないようにする。
  const [initial] = useState<Record<string, string>>(() => names ?? {});
  const [draft, setDraft] = useState<Map<string, string>>(() => new Map()); // 編集したコードだけ
  const [query, setQuery] = useState("");

  const rows = useMemo<Row[]>(() => {
    const used = wbsCodesWithAncestors(tasks.map((t) => t.wbsCode));
    const usedSet = new Set(used);
    const out: Row[] = used.map((code) => ({ code, unused: false }));
    for (const code of Object.keys(initial)) if (!usedSet.has(code)) out.push({ code, unused: true });
    return out.sort((a, b) => naturalWbsCompare(a.code, b.code));
  }, [tasks, initial]);

  const valueOf = (code: string) => draft.get(code) ?? wbsNameOf(code, initial);
  const setValue = (code: string, v: string) => setDraft((d) => new Map(d).set(code, v));
  const changed = [...draft].filter(([code, v]) => v.trim().slice(0, WBS_NAME_MAX) !== wbsNameOf(code, initial));
  const namedCount = [...new Set([...Object.keys(initial), ...draft.keys()])].filter((c) => valueOf(c).trim()).length;

  const q = query.trim().toLowerCase();
  const shown = q
    ? rows.filter((r) => r.code.toLowerCase().includes(q) || valueOf(r.code).toLowerCase().includes(q))
    : rows;

  const save = () => {
    const s = useApp.getState();
    if (selectReadOnly(s) || !changed.length) return;
    // 他の人・タブの同時変更を潰さないよう、変更したコードだけを最新の名称へ重ねる
    const next: Record<string, string> = { ...(s.project.wbsNames ?? {}) };
    for (const [code, v] of changed) next[code] = v;
    s.setWbsNames(next);
    s.showToast(`WBSの名称を保存しました（${changed.length}件）`);
    onClose();
  };

  return (
    <Dialog
      title="WBSの名称"
      subtitle={
        readOnly
          ? "閲覧のみのため編集できません。"
          : "WBSコードに表示名を付けます（例：1.2 → 配管設計）。ツリー・集約カード・表・ガントに表示されます。"
      }
      onClose={onClose}
      className="wbs-names-dialog"
    >
      <div className="dialog-body" data-testid="wbs-names-dialog">
        {rows.length ? (
          <>
            <input
              className="wbs-names-filter"
              type="search"
              data-autofocus
              placeholder="コード・名称で絞り込み"
              aria-label="WBSコード・名称で絞り込み"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="wbs-names-list">
              {shown.map(({ code, unused }) => {
                const value = valueOf(code);
                const tooLong = code.length > WBS_CODE_MAX;
                const depth = code.split(".").filter(Boolean).length - 1;
                return (
                  <div className="wbs-names-row" key={code}>
                    <span className="wbs-names-code" style={{ paddingLeft: depth * 10 }} title={code}>
                      {code}
                      {unused ? (
                        <span className="wbs-names-unused" title="この WBS コードのタスクはありません">
                          未使用
                        </span>
                      ) : null}
                    </span>
                    <input
                      value={value}
                      maxLength={WBS_NAME_MAX}
                      placeholder={tooLong ? `コードが長すぎます（最大${WBS_CODE_MAX}文字）` : "名称なし"}
                      disabled={readOnly || tooLong}
                      aria-label={`WBS ${code} の名称`}
                      data-testid={`wbs-name-input-${code}`}
                      onChange={(e) => setValue(code, e.target.value)}
                    />
                    {unused ? (
                      <button
                        type="button"
                        className="wbs-names-del"
                        disabled={readOnly || !value}
                        aria-label={`WBS ${code} の名称を削除`}
                        onClick={() => setValue(code, "")}
                      >
                        削除
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
              {!shown.length ? <div className="wbs-names-empty">一致する WBS がありません</div> : null}
            </div>
            {namedCount > WBS_NAMES_MAX ? (
              <p className="wbs-names-note">名称は最大 {WBS_NAMES_MAX} 件まで保存されます（超えた分は保存されません）。</p>
            ) : null}
          </>
        ) : (
          <p>WBSコードを持つタスクがありません。タスクに WBS（例：1.2）を設定すると名称を付けられます。</p>
        )}
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn" onClick={onClose}>
          キャンセル
        </button>
        <button
          type="button"
          className="btn primary"
          data-testid="wbs-names-save"
          disabled={readOnly || !changed.length}
          onClick={save}
        >
          {changed.length ? `保存（${changed.length}件）` : "保存"}
        </button>
      </div>
    </Dialog>
  );
}
