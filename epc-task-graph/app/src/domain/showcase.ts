import { emptyDoc, makeTask, makeDep } from "./factory";
import { addCalendarDays, computeCpm } from "./cpm";
import { isValidIsoDate } from "./schema";
import { baselinePatch, todayIso } from "./schedule";
import type { Discipline, Status } from "./types";
/** 計画開始（ベースライン）は進捗の締め日の何週前か。 */
const SHOWCASE_PLAN_WEEKS = 4;
/**
 * Illustrative EPC project. Only used for a new, empty browser; existing documents are retained.
 * 進捗の締め日は statusDate（省略時は今日）以前の直近の月曜。計画はその 4 週前の月曜開始で組み、
 * 完了（実績日あり）・着手済み・未着手と数日の遅れを含む。祝日なし＋週単位の丸めで、
 * どの週に開いても締め日からの相対的な見え方は同じになる。
 */
export function showcaseDoc(statusDate?: string) {
  const given = (statusDate ?? "").slice(0, 10);
  const base = isValidIsoDate(given) ? given : todayIso();
  const dow = new Date(base + "T00:00:00Z").getUTCDay();
  const dataDate = addCalendarDays(base, -((dow + 6) % 7));
  const planStart = addCalendarDays(dataDate, -7 * SHOWCASE_PLAN_WEEKS);
  // 計画開始から w 稼働日目（月〜金・祝日なし）の日付。
  const wd = (w: number) =>
    addCalendarDays(planStart, 7 * Math.floor(w / 5) + (w % 5));
  const doc = emptyDoc("千葉プラント 増設プロジェクト");
  doc.project.description =
    "サンプルデータ — 架空のEPCプロジェクト。自由に編集してお試しください。";
  doc.project.dataDate = dataDate;
  const rows: [
    string,
    string,
    Discipline,
    number,
    Status,
    number,
    string,
    number,
    number,
    boolean?,
  ][] = [
    ["プロジェクト開始", "1.1", "E", 0, "DONE", 100, "設計1課", 40, 60, true],
    ["設計条件の確認", "1.1", "E", 4, "DONE", 100, "設計1課", 340, 60],
    ["基本設計", "1.1", "E", 10, "DONE", 100, "設計1課", 640, 60],
    ["主要機器の仕様確定", "1.2", "E", 8, "IN_PROGRESS", 70, "機械課", 940, 60],
    ["配置・配管設計", "1.2", "E", 12, "IN_PROGRESS", 45, "配管課", 940, 280],
    [
      "電気・計装設計",
      "1.3",
      "E",
      10,
      "IN_PROGRESS",
      30,
      "電気計装課",
      940,
      500,
    ],
    [
      "設計レビュー完了",
      "1.3",
      "E",
      0,
      "NOT_STARTED",
      0,
      "設計1課",
      1240,
      280,
      true,
    ],
    ["機器発注", "2.1", "P", 5, "ON_HOLD", 0, "調達課", 1240, 60],
    ["機器製作・検査", "2.1", "P", 20, "NOT_STARTED", 0, "調達課", 1540, 60],
    ["配管資材の調達", "2.2", "P", 14, "NOT_STARTED", 0, "調達課", 1240, 500],
    [
      "電気機器の調達",
      "2.3",
      "P",
      16,
      "NOT_STARTED",
      0,
      "電気計装課",
      1240,
      720,
    ],
    [
      "主要機器の現地搬入",
      "2.1",
      "P",
      0,
      "NOT_STARTED",
      0,
      "調達課",
      1840,
      60,
      true,
    ],
    ["仮設・準備工事", "3.1", "C", 6, "DONE", 100, "施工管理課", 640, 720],
    ["基礎工事", "3.1", "C", 12, "IN_PROGRESS", 75, "土木1課", 940, 720],
    ["機器据付", "3.2", "C", 8, "NOT_STARTED", 0, "施工管理課", 2140, 60],
    ["配管工事", "3.2", "C", 14, "NOT_STARTED", 0, "配管課", 2440, 280],
    [
      "電気・計装工事",
      "3.3",
      "C",
      10,
      "NOT_STARTED",
      0,
      "電気計装課",
      2440,
      500,
    ],
    [
      "機械的完成",
      "3.3",
      "C",
      0,
      "NOT_STARTED",
      0,
      "施工管理課",
      2740,
      280,
      true,
    ],
    [
      "試運転・性能確認",
      "4.1",
      "C",
      7,
      "NOT_STARTED",
      0,
      "試運転課",
      3040,
      280,
    ],
    [
      "完成図書の引き渡し",
      "4.1",
      "E",
      5,
      "NOT_STARTED",
      0,
      "設計2課",
      3040,
      500,
    ],
    [
      "引き渡し完了",
      "4.2",
      "C",
      0,
      "NOT_STARTED",
      0,
      "施工管理課",
      3340,
      280,
      true,
    ],
  ];
  doc.tasks = rows.map(
    ([
      name,
      wbsCode,
      discipline,
      durationDays,
      status,
      progress,
      assignee,
      x,
      y,
      isMilestone,
    ]) =>
      makeTask(
        {
          name,
          wbsCode,
          discipline,
          durationDays,
          status,
          progress,
          assignee,
          position: { x, y },
          isMilestone,
          notes:
            name === "機器発注"
              ? "ベンダーの最終見積を確認中。機械課と仕様の差分を確認してから発注を再開する。"
              : "",
        },
        "サンプル",
      ),
  );
  const links = [
    [0, 1],
    [1, 2],
    [2, 3],
    [2, 4],
    [2, 5],
    [3, 6],
    [4, 6],
    [5, 6],
    [3, 7],
    [7, 8],
    [8, 11],
    [4, 9],
    [5, 10],
    [0, 12],
    [12, 13],
    [13, 14],
    [11, 14],
    [6, 14],
    [14, 15],
    [9, 15],
    [14, 16],
    [10, 16],
    [15, 17],
    [16, 17],
    [17, 18],
    [17, 19],
    [18, 20],
    [19, 20],
  ];
  doc.dependencies = links.map(([a, b]) =>
    makeDep(doc.tasks[a].id, doc.tasks[b].id),
  );
  // 当初計画（全タスク未着手として計画開始日から CPM）をベースラインに保存する。
  const plan = computeCpm(
    doc.tasks.map((t) => ({ ...t, status: "NOT_STARTED" as Status })),
    doc.dependencies,
    planStart,
    doc.calendars[0],
  );
  // 実績（計画開始からの稼働日番号: [実績開始, 実績完了|null]）。設計・仮設は少し遅れて完了。
  const actuals = new Map<number, [number, number | null]>([
    [0, [0, 0]],
    [1, [0, 3]],
    [2, [4, 14]],
    [3, [15, null]],
    [4, [15, null]],
    [5, [15, null]],
    [12, [0, 7]],
    [13, [8, null]],
  ]);
  doc.tasks = doc.tasks.map((t, i) => {
    const r = plan.byTask.get(t.id);
    const a = actuals.get(i);
    return {
      ...t,
      ...(r ? baselinePatch(r) : {}),
      ...(a
        ? {
            actualStart: wd(a[0]),
            actualFinish: a[1] == null ? null : wd(a[1]),
          }
        : {}),
    };
  });
  doc.viewState = { collapsedWbs: [], expandLevel: 2 };
  return doc;
}
