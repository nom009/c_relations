// 祝日プリセット（§9.1 稼働カレンダー）: 日本の祝日・年末年始・お盆の一括追加と全クリア。
// 左パネル（即時反映・updateCalendar 経由）と設定ダイアログ（下書きに取り込み、保存時に反映）で共用。閲覧のみは非表示。
import { useState } from "react";
import { useApp, selectActiveCalendar, selectReadOnly } from "../store/store";
import { useCpm } from "../store/hooks";
import {
  japaneseHolidays,
  yearEndHolidays,
  obonHolidays,
  mergeHolidays,
} from "../domain";

const MAX_YEARS = 15;

// 対象年: 基準日の前年〜計算上の完了年の翌年（最大15年分）。
function presetYearRange(dataDate: string, endDate: string): [number, number] {
  const from = (Number(dataDate.slice(0, 4)) || new Date().getFullYear()) - 1;
  const endYear = Number(endDate.slice(0, 4)) || from + 1;
  const to = Math.min(Math.max(endYear + 1, from), from + MAX_YEARS - 1);
  return [from, to];
}

export function HolidayPresets({
  draft,
  onDraftChange,
  showStatus = false,
}: {
  /** 指定時は下書きモード: ストアへは書かず、この日付一覧を onDraftChange で更新する（保存は呼び出し側） */
  draft?: string[];
  onDraftChange?: (dates: string[]) => void;
  /** トーストが隠れるモーダル内用に、結果を欄内にも表示する */
  showStatus?: boolean;
}) {
  const cal = useApp(selectActiveCalendar);
  const readOnly = useApp(selectReadOnly);
  const dataDate = useApp((s) => s.project.dataDate);
  const { projectEndDate } = useCpm();
  const [status, setStatus] = useState("");
  if (!cal || readOnly) return null;
  const [from, to] = presetYearRange(dataDate, projectEndDate);
  const local = draft && onDraftChange ? { dates: draft, set: onDraftChange } : null;
  const pendingNote = local ? "（「変更を保存」で反映）" : "";

  const report = (msg: string) => {
    if (!local) useApp.getState().showToast(msg);
    setStatus(msg);
  };
  const add = (dates: string[]) => {
    const s = useApp.getState();
    const current = local ? local.dates : selectActiveCalendar(s)?.holidays ?? [];
    const have = new Set(current);
    const n = new Set(dates.filter((d) => !have.has(d))).size;
    if (n > 0) {
      const next = mergeHolidays(current, dates);
      if (local) local.set(next);
      else s.updateCalendar({ holidays: next });
    }
    report(
      `祝日を ${n} 件追加しました` +
        (n === 0 ? "（すべて登録済み）" : pendingNote),
    );
  };
  const clear = () => {
    if (local) {
      local.set([]);
    } else {
      if (!window.confirm("登録済みの祝日・休業日をすべて削除しますか？")) return;
      useApp.getState().updateCalendar({ holidays: [] });
    }
    report("祝日をすべてクリアしました" + pendingNote);
  };
  const canClear = local ? local.dates.length > 0 : cal.holidays.length > 0;

  return (
    <div className="holiday-presets" data-testid="holiday-presets">
      <div className="holiday-presets-buttons">
        <button
          type="button"
          className="btn"
          title={`${from}〜${to}年の国民の祝日・振替休日を追加`}
          onClick={() => add(japaneseHolidays(from, to).map((h) => h.date))}
        >
          日本の祝日を追加
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => add(yearEndHolidays(from, to))}
        >
          年末年始（12/29〜1/3）を追加
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => add(obonHolidays(from, to))}
        >
          お盆（8/13〜8/16）を追加
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={!canClear}
          onClick={clear}
        >
          祝日をすべてクリア
        </button>
      </div>
      <small className="holiday-presets-note">
        対象: {from}〜{to}年（基準日の前年〜完了予定の翌年）
      </small>
      {showStatus ? (
        <small className="holiday-presets-note" role="status">
          {status}
        </small>
      ) : null}
    </div>
  );
}
