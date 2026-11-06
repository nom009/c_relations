import { useState } from "react";
import { useApp, selectActiveCalendar } from "../../store/store";
import { isValidIsoDate } from "../../domain";
import { Dialog } from "./Dialog";
export function SettingsDialog({
  onClose,
  isNew = false,
}: {
  onClose: () => void;
  isNew?: boolean;
}) {
  const project = useApp((s) => s.project),
    cal = useApp(selectActiveCalendar),
    me = useApp((s) => s.me);
  const [name, setName] = useState(isNew ? "" : project.name),
    [date, setDate] = useState(
      isNew ? new Date().toLocaleDateString("sv-SE") : project.dataDate,
    ),
    [user, setUser] = useState(me),
    [working, setWorking] = useState(cal?.workingDays ?? [1, 2, 3, 4, 5]),
    [holidays, setHolidays] = useState(cal?.holidays.join("\n") ?? ""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={isNew ? "プロジェクトを作成" : "プロジェクト設定"}
      subtitle={
        isNew
          ? "名前と開始基準日を決めて、工程づくりを始めましょう。"
          : "工程計算とワークスペースの基本設定"
      }
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          const s = useApp.getState();
          if (isNew) {
            const previous = s.project.id;
            await s.newProject(name.trim());
            if (useApp.getState().project.id === previous) {
              setBusy(false);
              return;
            }
          } else s.renameProject(name.trim());
          s.setDataDate(date);
          if (!isNew) {
            s.setMe(user.trim() || "私");
            s.updateCalendar({
              workingDays: working,
              holidays: holidays
                .split(/[\s,]+/)
                .filter(isValidIsoDate),
            });
          }
          s.showToast(
            isNew ? "新しいプロジェクトを開きました" : "設定を保存しました",
          );
          setBusy(false);
          onClose();
        }}
      >
        <div className="dialog-body">
          <label className="form-field">
            プロジェクト名
            <input
              required
              data-autofocus
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：千葉プラント 増設工事"
            />
          </label>
          <label className="form-field">
            工程計算の開始基準日
            <input
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <small>
              この日を起点に、依存関係と稼働日から日程を計算します。
            </small>
          </label>
          {!isNew && (
            <>
              <label className="form-field">
                あなたの担当部署
                <input
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="例：設計1課"
                />
                <small>「自分のタスク」の絞り込みに使います。</small>
              </label>
              <div className="form-field">
                稼働曜日
                <div className="settings-week">
                  {["日", "月", "火", "水", "木", "金", "土"].map((d, i) => (
                    <button
                      type="button"
                      key={d}
                      aria-pressed={working.includes(i)}
                      className={working.includes(i) ? "active" : ""}
                      disabled={working.length === 1 && working.includes(i)}
                      onClick={() =>
                        setWorking((a) =>
                          a.includes(i)
                            ? a.filter((n) => n !== i)
                            : [...a, i].sort(),
                        )
                      }
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <details className="form-details">
                <summary>祝日・休業日を設定</summary>
                <label className="form-field">
                  1行に1日（例：2026-09-21）
                  <textarea
                    rows={4}
                    value={holidays}
                    onChange={(e) => setHolidays(e.target.value)}
                  />
                </label>
              </details>
              <div className="storage-note">
                データはこのブラウザに保存されます。端末を移す際は「データ」からJSONを書き出してください。
              </div>
            </>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || !name.trim()}
          >
            {busy ? "保存中…" : isNew ? "プロジェクトを作成" : "変更を保存"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
