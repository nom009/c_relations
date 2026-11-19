import { useState } from "react";
import { useApp, selectActiveCalendar, selectReadOnly } from "../../store/store";
import { isValidIsoDate, mergeHolidays, todayIso } from "../../domain";
import { API_MODE } from "../../storage/mode";
import { Dialog } from "./Dialog";
import { WbsNamesDialog } from "./WbsNamesDialog";
import { HolidayPresets } from "../HolidayPresets";
export function SettingsDialog({
  onClose,
  isNew = false,
}: {
  onClose: () => void;
  isNew?: boolean;
}) {
  const project = useApp((s) => s.project),
    cal = useApp(selectActiveCalendar),
    me = useApp((s) => s.me),
    storagePersisted = useApp((s) => s.storagePersisted),
    account = useApp((s) => s.account),
    readOnly = useApp(selectReadOnly);
  const [name, setName] = useState(isNew ? "" : project.name),
    [date, setDate] = useState(
      isNew ? new Date().toLocaleDateString("sv-SE") : project.dataDate,
    ),
    [user, setUser] = useState(me),
    [working, setWorking] = useState(cal?.workingDays ?? [1, 2, 3, 4, 5]),
    [holidays, setHolidays] = useState(cal?.holidays.join("\n") ?? ""),
    [busy, setBusy] = useState(false),
    [namesOpen, setNamesOpen] = useState(false);
  return (
    <>
    <Dialog
      title={isNew ? "プロジェクトを作成" : "プロジェクト設定"}
      subtitle={
        isNew
          ? "名前と基準日を決めて、工程づくりを始めましょう。"
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
            基準日（進捗の締め日）
            <span className="date-input-row">
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                data-testid="settings-data-date-today"
                onClick={() => setDate(todayIso())}
              >
                今日
              </button>
            </span>
            <small>
              {isNew
                ? "工程計算の起点です。進捗を記録し始めたら、締め日（通常は今日）に進めます。"
                : "この日から残りの日程を計算します。完了タスクは実績日で固定、着手済みタスクは残作業をこの日から再計算します。進捗を更新したら今日に進めてください。"}
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
                {/* プリセットはストアへ即時反映し、編集中の下書きにも取り込む */}
                <HolidayPresets
                  showStatus
                  canClear={holidays.trim() !== "" || (cal?.holidays.length ?? 0) > 0}
                  onAdded={(dates) =>
                    setHolidays((h) =>
                      mergeHolidays(
                        h.split(/[\s,]+/).filter(isValidIsoDate),
                        dates,
                      ).join("\n"),
                    )
                  }
                  onCleared={() => setHolidays("")}
                />
              </details>
              {!readOnly && (
                <div className="form-field">
                  WBSの名称
                  <div>
                    <button
                      type="button"
                      className="btn"
                      data-testid="settings-wbs-names"
                      onClick={() => setNamesOpen(true)}
                    >
                      WBSの名称を編集
                    </button>
                  </div>
                  <small>
                    WBSコードに表示名（例：1.2 → 配管設計）を付けます。名称はそのダイアログで保存した時点で反映されます。
                  </small>
                </div>
              )}
              <div className="storage-note">
                {API_MODE ? (
                  <div data-testid="storage-server">
                    保存先: サーバー（ログイン中: {account?.email ?? "不明"}）{" "}
                    <a href="/.auth/logout?post_logout_redirect_uri=/">ログアウト</a>
                  </div>
                ) : (
                  <>
                    データはこのブラウザに保存されます。端末を移す際は「データ」からJSONを書き出してください。
                    {storagePersisted !== null && (
                      <div data-testid="storage-persisted">
                        {storagePersisted
                          ? "保存領域: 保護済み"
                          : "保存領域: 未保護（ブラウザが容量不足時に削除する場合があります。定期的にJSONで書き出してください）"}
                      </div>
                    )}
                  </>
                )}
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
            disabled={busy || !name.trim() || (!isNew && readOnly)}
          >
            {busy ? "保存中…" : isNew ? "プロジェクトを作成" : "変更を保存"}
          </button>
        </div>
      </form>
    </Dialog>
    {/* 設定ダイアログの上に重ねる（form の入れ子と Esc の伝播を避けるため兄弟に置く） */}
    {namesOpen ? <WbsNamesDialog onClose={() => setNamesOpen(false)} /> : null}
    </>
  );
}
