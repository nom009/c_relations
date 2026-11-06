// ============================================================================
// MSPDI（MS Project Data Interchange・XML）連携 — §8 / Phase 5 下ごしらえ。
// UI/DOM 非依存の純関数（テスト環境=node のため DOMParser を使わず軽量パーサで実装）。
// スコープ: タスク（名前・WBS・所要日数・マイルストーン）＋依存（タイプ FS/SS/FF/SF・ラグ）の
// 往復。リソース/カレンダー/実績は Phase 5 本実装で拡張（担当はここでは非対応）。
// ============================================================================
import type { Dependency, DependencyType, GraphDoc, Task } from './types';
import type { CpmResult } from './cpm';
import { addCalendarDays } from './cpm';
import { makeDep, makeTask } from './factory';

const MIN_PER_DAY = 480; // 8h/日（MSP 既定）。MSPDI Duration/LinkLag の日換算に使用。

// 依存タイプ ↔ MSPDI Type コード（0=FF, 1=FS, 2=SF, 3=SS）。
const TYPE_TO_CODE: Record<DependencyType, number> = { FF: 0, FS: 1, SF: 2, SS: 3 };
const CODE_TO_TYPE: Record<number, DependencyType> = { 0: 'FF', 1: 'FS', 2: 'SF', 3: 'SS' };

const escXml = (s: string): string =>
  (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const decXml = (s: string): string =>
  (s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/&/g, '&amp;'))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h: string) => codePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d: string) => codePoint(parseInt(d, 10), m))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
function codePoint(n: number, fallback: string): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

// ---- エクスポート: GraphDoc → MSPDI XML。cpm を渡すと Start/Finish を書き出す ----
export function toMspdi(doc: GraphDoc, cpm?: CpmResult | null): string {
  const idToUid = new Map<string, number>();
  doc.tasks.forEach((t, i) => idToUid.set(t.id, i + 1));

  const depsBySucc = new Map<string, Dependency[]>();
  for (const d of doc.dependencies) {
    if (!depsBySucc.has(d.successorId)) depsBySucc.set(d.successorId, []);
    depsBySucc.get(d.successorId)!.push(d);
  }

  const taskXml = doc.tasks
    .map((t, i) => {
      const uid = i + 1;
      const durHours = (t.isMilestone ? 0 : Math.max(0, t.durationDays)) * (MIN_PER_DAY / 60);
      const dur = `PT${durHours}H0M0S`;
      const outlineLevel = (t.wbsCode || '').split('.').filter(Boolean).length || 1;
      const links = (depsBySucc.get(t.id) ?? [])
        .filter((d) => idToUid.has(d.predecessorId))
        .map(
          (d) =>
            `\n      <PredecessorLink>\n        <PredecessorUID>${idToUid.get(d.predecessorId)}</PredecessorUID>\n        <Type>${TYPE_TO_CODE[d.type]}</Type>\n        <LinkLag>${Math.round((d.lagDays || 0) * MIN_PER_DAY * 10)}</LinkLag>\n        <LagFormat>7</LagFormat>\n      </PredecessorLink>`,
        )
        .join('');
      const r = cpm?.byTask.get(t.id);
      // CPM の ef は排他的終端（最終稼働日の翌日）。MSP の Finish は最終作業日の終業時刻なので 1 日戻す。
      const hasWork = !t.isMilestone && t.durationDays > 0;
      const finish = r ? (hasWork ? `${addCalendarDays(r.efDate, -1)}T17:00:00` : `${r.esDate}T08:00:00`) : '';
      const dates = r ? `\n      <Start>${r.esDate}T08:00:00</Start>\n      <Finish>${finish}</Finish>` : '';
      return `\n    <Task>\n      <UID>${uid}</UID>\n      <ID>${uid}</ID>\n      <Name>${escXml(t.name)}</Name>\n      <WBS>${escXml(t.wbsCode)}</WBS>\n      <OutlineNumber>${escXml(t.wbsCode)}</OutlineNumber>\n      <OutlineLevel>${outlineLevel}</OutlineLevel>\n      <Duration>${dur}</Duration>\n      <DurationFormat>7</DurationFormat>\n      <Milestone>${t.isMilestone ? 1 : 0}</Milestone>\n      <Summary>0</Summary>${dates}${links}\n    </Task>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Project xmlns="http://schemas.microsoft.com/project">\n  <Name>${escXml(doc.project.name)}</Name>\n  <Tasks>${taskXml}\n  </Tasks>\n</Project>\n`;
}

// ---- インポート: MSPDI XML → { tasks, dependencies }。要約(WBS親)タスクはスキップ ----
export function fromMspdi(xml: string, by = '私'): { tasks: Task[]; dependencies: Dependency[] } {
  // 開始タグは属性付き（例: <Task xmlns="...">）も許容する。<Tasks> には一致しない。
  const field = (block: string, tag: string): string => {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
    return m ? m[1].trim() : '';
  };
  const taskBlocks = xml.match(/<Task(?:\s[^>]*)?>[\s\S]*?<\/Task>/g) ?? [];

  interface P {
    uid: string;
    name: string;
    wbs: string;
    durDays: number;
    milestone: boolean;
    links: { predUid: string; type: number; lagDays: number }[];
  }
  const parsed: P[] = [];
  for (const block of taskBlocks) {
    if (field(block, 'Summary') === '1') continue; // 要約タスク（WBS親）は除外
    const uid = field(block, 'UID');
    if (!uid) continue;
    const milestone = field(block, 'Milestone') === '1';
    const durRaw = field(block, 'Duration'); // PT{H}H{M}M{S}S
    const hm = /PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?/.exec(durRaw);
    const hours = hm ? Number(hm[1] || 0) + Number(hm[2] || 0) / 60 : 0;
    const durDays = milestone ? 0 : Math.round(hours / (MIN_PER_DAY / 60));
    const links: P['links'] = [];
    for (const lb of block.match(/<PredecessorLink(?:\s[^>]*)?>[\s\S]*?<\/PredecessorLink>/g) ?? []) {
      const predUid = field(lb, 'PredecessorUID');
      if (!predUid) continue;
      links.push({
        predUid,
        type: Number(field(lb, 'Type') || 1),
        lagDays: Math.round(Number(field(lb, 'LinkLag') || 0) / (MIN_PER_DAY * 10)),
      });
    }
    parsed.push({
      uid,
      name: decXml(field(block, 'Name')),
      wbs: decXml(field(block, 'WBS') || field(block, 'OutlineNumber')),
      durDays,
      milestone,
      links,
    });
  }

  const uidToId = new Map<string, string>();
  const tasks: Task[] = parsed.map((p) => {
    const t = makeTask(
      { name: p.name || '（無題）', wbsCode: p.wbs, durationDays: p.durDays, isMilestone: p.milestone },
      by,
    );
    uidToId.set(p.uid, t.id);
    return t;
  });

  const dependencies: Dependency[] = [];
  const seenPairs = new Set<string>(); // 本アプリは同一の先行→後続ペアを1本に限る（重複は先勝ち）
  for (const p of parsed) {
    const succId = uidToId.get(p.uid)!;
    for (const l of p.links) {
      const predId = uidToId.get(l.predUid);
      if (!predId || predId === succId) continue;
      const pair = predId + '>' + succId;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      dependencies.push(makeDep(predId, succId, { type: CODE_TO_TYPE[l.type] ?? 'FS', lagDays: l.lagDays }, by));
    }
  }
  return { tasks, dependencies };
}
