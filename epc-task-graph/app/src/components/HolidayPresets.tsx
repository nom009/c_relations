// 祝日プリセット（§9.1 稼働カレンダー）: 日本の祝日・年末年始・お盆の一括追加と全クリア。
// 左パネルと設定ダイアログで共用。反映は updateCalendar 経由（閲覧のみの場合は非表示）。
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
  onAdded,
  onCleared,
  canClear,
  showStatus = false,
}: {
  /** 追加対象の日付（ストアへは反映済み）。下書きを持つ編集欄はここで取り込む */
  onAdded?: (dates: string[]) => void;
  onCleared?: () => void;
  /** クリア対象があるか（省略時はストアの祝日件数で判定） */
  canClear?: boolean;
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

  const add = (dates: string[]) => {
    const s = useApp.getState();
    const current = selectActiveCalendar(s)?.holidays ?? [];
    const have = new Set(current);
    const n = new Set(dates.filter((d) => !have.has(d))).size;
    if (n > 0) s.updateCalendar({ holidays: mergeHolidays(current, dates) });
    const msg = `祝日を ${n} 件追加しました` + (n === 0 ? "（すべて登録済み）" : "");
    s.showToast(msg);
    setStatus(msg);
    onAdded?.(dates);
  };
  const clear = () => {
    if (!window.confirm("登録済みの祝日・休業日をすべて削除しますか？")) return;
    const s = useApp.getState();
    s.updateCalendar({ holidays: [] });
    s.showToast("祝日をすべてクリアしました");
    setStatus("祝日をすべてクリアしました");
    onCleared?.();
  };

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
          disabled={!(canClear ?? cal.holidays.length > 0)}
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
