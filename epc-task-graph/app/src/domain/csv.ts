// ============================================================================
// CSV（Excel）入出力: 標準テンプレート列 ⇄ Task/Dependency。UI非依存の純関数。
// 依存は「先行タスク」列に No で書く（例: 3 / 3FS+2 / 4SS-1、複数は , 区切り）。
// No 列が無い旧形式は WBS（WBS が一意な場合）またはデータ行の順番で参照する。
// ============================================================================
import type { Dependency, DependencyType, Discipline, Status, Task } from './types';
import { makeDep, makeTask } from './factory';
import { MAX_DAYS, isValidIsoDate } from './schema';
import { topoSort } from './graph';
import { naturalWbsCompare } from './wbs';

export const CSV_COLUMNS = [
  'No',
  'WBS',
  'タスク名',
  '工種',
  '所要日数',
  'マイルストーン',
  '先行タスク',
  'ステータス',
  '進捗(%)',
  '担当',
  '開始日',
  '期限',
  '実績開始日',
  '実績完了日',
  '備考',
  'ID',
] as const;

// CSV が持つ（取込で上書きし得る）タスク項目。現在のプロジェクトの更新取込で使う。
export type CsvTaskField = Extract<
  keyof Task,
  | 'name'
  | 'wbsCode'
  | 'discipline'
  | 'isMilestone'
  | 'durationDays'
  | 'status'
  | 'progress'
  | 'assignee'
  | 'constraintType'
  | 'constraintDate'
  | 'notes'
  | 'actualStart'
  | 'actualFinish'
>;
export const CSV_TASK_FIELDS: readonly CsvTaskField[] = [
  'name',
  'wbsCode',
  'discipline',
  'isMilestone',
  'durationDays',
  'status',
  'progress',
  'assignee',
  'constraintType',
  'constraintDate',
  'notes',
  'actualStart',
  'actualFinish',
];

type Col =
  | 'no'
  | 'wbs'
  | 'name'
  | 'discipline'
  | 'duration'
  | 'milestone'
  | 'pred'
  | 'status'
  | 'progress'
  | 'assignee'
  | 'start'
  | 'deadline'
  | 'actualStart'
  | 'actualFinish'
  | 'notes'
  | 'id';

// 見出しの別名（正規化後に照合）。Excel 側の既存列名をなるべくそのまま受ける。
const HEADER_ALIASES: Record<Col, string[]> = {
  no: ['no', 'no.', '番号', 'タスク番号', 'タスクno', 'タスクno.', '#'],
  wbs: ['wbs', 'wbsコード', 'wbs番号', 'wbsno'],
  name: ['タスク名', '作業名', '名称', 'タスク', '作業', 'name', 'taskname'],
  discipline: ['工種', '分類', 'discipline'],
  duration: ['所要日数', '所要日数(日)', '日数', '工期', '工期(日)', '期間', 'duration'],
  milestone: ['マイルストーン', 'milestone'],
  pred: ['先行タスク', '先行', '先行作業', 'predecessors'],
  status: ['ステータス', '状態', 'status'],
  progress: ['進捗(%)', '進捗', '進捗率', '進捗率(%)', 'progress', '%complete'],
  assignee: ['担当', '担当者', 'assignee'],
  start: ['開始日', '開始', '着手日', 'start'],
  deadline: ['期限', '期限日', '納期', '締切', 'deadline'],
  actualStart: ['実績開始日', '実績開始', '着手実績', 'actualstart'],
  actualFinish: ['実績完了日', '実績完了', '実績終了日', '実績終了', '完了実績', 'actualfinish'],
  notes: ['備考', 'メモ', 'notes'],
  id: ['id', 'タスクid', 'taskid', '内部id'],
};

// 列 → その列が決めるタスク項目（開始日/期限はどちらも制約を決める）。
const COL_FIELDS: Partial<Record<Col, CsvTaskField[]>> = {
  wbs: ['wbsCode'],
  name: ['name'],
  discipline: ['discipline'],
  duration: ['durationDays'],
  milestone: ['isMilestone'],
  status: ['status'],
  progress: ['progress'],
  assignee: ['assignee'],
  start: ['constraintType', 'constraintDate'],
  deadline: ['constraintType', 'constraintDate'],
  actualStart: ['actualStart'],
  actualFinish: ['actualFinish'],
  notes: ['notes'],
};

const DISC_ALIASES: Record<string, Discipline> = {
  e: 'E',
  設計: 'E',
  engineering: 'E',
  p: 'P',
  調達: 'P',
  procurement: 'P',
  c: 'C',
  施工: 'C',
  工事: 'C',
  construction: 'C',
  other: 'OTHER',
  その他: 'OTHER',
};

const STATUS_ALIASES: Record<string, Status> = {
  not_started: 'NOT_STARTED',
  未着手: 'NOT_STARTED',
  in_progress: 'IN_PROGRESS',
  進行中: 'IN_PROGRESS',
  作業中: 'IN_PROGRESS',
  done: 'DONE',
  完了: 'DONE',
  on_hold: 'ON_HOLD',
  保留: 'ON_HOLD',
};

const TRUE_WORDS = ['○', '〇', '◯', '●', '◆', '✓', '✔', 'v', '1', 'true', 'yes', 'y', 'はい', 'ms'];
const FALSE_WORDS = ['0', 'false', 'no', 'n', 'いいえ', '-', '×', '✕'];

// 全角英数・全角括弧などを半角へ寄せ、照合用に前後空白を落とす。
const norm = (s: string) => s.normalize('NFKC').trim();
const key = (s: string) => norm(s).toLowerCase().replace(/\s+/g, '');
// No / 行番号の照合キー。"03" と "3" を同一視する。
const noKey = (s: string) => {
  const t = norm(s);
  return /^\d+$/.test(t) ? String(Number(t)) : t;
};
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---- 低レベル CSV（RFC 4180: 引用符・埋め込み改行・"" エスケープ）----
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// Excel(日本語版) の既定 CSV は Shift_JIS(CP932)。UTF-8 として厳密に読めなければ SJIS とみなす。
// 「Unicode テキスト」保存（UTF-16 + BOM・タブ区切り）も受ける。
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

// Excel で開いたときに式として評価されないよう、テキスト列の先頭記号を ' で無害化する。
const FORMULA_START = /^[=+\-@\t\r]/;
const guardText = (s: string) => (FORMULA_START.test(s) ? "'" + s : s);
const unguardText = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

function csvCell(s: string): string {
  return /[",\r\n]|^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsvText(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---- 値の解釈 ----
export function parseCsvDate(raw: string): string | null {
  const s = norm(raw);
  let m = /^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

function parseNumber(raw: string): number | null {
  const s = norm(raw).replace(/,/g, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const DEP_TYPES: DependencyType[] = ['FS', 'SS', 'FF', 'SF'];
const PRED_RE = /^(.+?)\s*(FS|SS|FF|SF)\s*(?:([+-])\s*(\d+(?:\.\d+)?)\s*(?:日|d|days?|営業日)?)?$/i;

interface PredRef {
  ref: string;
  type: DependencyType;
  lagDays: number;
}

// 1トークン（例: "3" / "3FS+2" / "1.3 SS-1日"）を解釈する。参照キーの完全一致を最優先
// （"A-1" のようなハイフン入り WBS をラグと誤読しないため）。
function parsePredToken(token: string, known: Set<string>, toKey: (s: string) => string): PredRef | null {
  const t = norm(token);
  const whole = toKey(t);
  if (known.has(whole)) return { ref: whole, type: 'FS', lagDays: 0 };
  const m = PRED_RE.exec(t);
  if (!m) return { ref: whole, type: 'FS', lagDays: 0 };
  const type = m[2].toUpperCase() as DependencyType;
  if (!DEP_TYPES.includes(type)) return null;
  const lag = m[4] ? Math.round(Number(m[4])) * (m[3] === '-' ? -1 : 1) : 0;
  return { ref: toKey(m[1].trim()), type, lagDays: lag };
}

export interface CsvImportResult {
  tasks: Task[];
  dependencies: Dependency[];
  errors: string[];
  warnings: string[];
  // 開始日列の最早日。取込プロジェクトの基準日に使う。
  earliestStart: string | null;
  // CSV に列があったタスク項目（無い列の項目は更新取込で既存値を保つ）。
  fields: CsvTaskField[];
  // 「先行タスク」列の有無（無ければ更新取込で既存の依存を保つ）。
  hasPredecessors: boolean;
  // 「ID」列の有無（更新取込でタスクを突き合わせるキー）。
  hasIds: boolean;
}

export function fromCsv(text: string, by = '私'): CsvImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const empty = (): CsvImportResult => ({
    tasks: [],
    dependencies: [],
    errors,
    warnings,
    earliestStart: null,
    fields: [],
    hasPredecessors: false,
    hasIds: false,
  });
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows = parseCsvRows(text, delimiter);
  const headerColumns = (r: string[]) => {
    const idx: Partial<Record<Col, number>> = {};
    r.forEach((h, i) => {
      const k = key(h);
      for (const col of Object.keys(HEADER_ALIASES) as Col[]) {
        if (idx[col] == null && HEADER_ALIASES[col].includes(k)) idx[col] = i;
      }
    });
    return idx;
  };
  if (!rows.some((r) => r.some((c) => norm(c) !== ''))) {
    errors.push('CSVが空です');
    return empty();
  }

  // 見出し行: Excel の表題行などを読み飛ばすため、先頭20行から「WBS」「タスク名」を含む行を探す。
  let headerIdx = -1;
  let colIdx: Partial<Record<Col, number>> = {};
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const idx = headerColumns(rows[r]);
    if (idx.wbs != null && idx.name != null) {
      headerIdx = r;
      colIdx = idx;
      break;
    }
  }
  if (headerIdx < 0) {
    errors.push(
      '見出し行に「WBS」と「タスク名」の列が必要です（先頭20行以内・テンプレートの見出しをそのまま使ってください）',
    );
    return empty();
  }
  const hasCol = (c: Col) => colIdx[c] != null;

  // 参照用の行情報（エラー行も含む）。task はエラーなく読めた行だけ持つ。
  interface Row {
    line: number;
    seq: number;
    no: string;
    wbs: string;
    predRaw: string;
    task: Task | null;
  }
  const all: Row[] = [];
  const noLine = new Map<string, number>();
  const idLine = new Map<string, number>();
  let earliestStart: string | null = null;

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells.some((c) => norm(c) !== '')) continue;
    const line = r + 1;
    const get = (c: Col) => (colIdx[c] != null ? (cells[colIdx[c]!] ?? '') : '');
    const err = (msg: string) => errors.push(`${line}行目: ${msg}`);
    const errCount = errors.length;
    const row: Row = { line, seq: all.length + 1, no: '', wbs: '', predRaw: get('pred'), task: null };
    all.push(row);

    row.no = noKey(get('no'));
    if (row.no) {
      if (noLine.has(row.no)) err(`No「${row.no}」が${noLine.get(row.no)}行目と重複しています`);
      else noLine.set(row.no, line);
    }

    // WBS はグループ分けのコードで、複数タスクが同じ値を持てる（空欄も可）。
    const wbs = norm(get('wbs'));
    row.wbs = wbs;
    const name = unguardText(get('name').trim());
    if (!name) err('タスク名が空です');

    let id: string | null = null;
    const idRaw = norm(unguardText(get('id').trim()));
    if (idRaw) {
      if (!ID_RE.test(idRaw))
        warnings.push(`${line}行目: ID「${idRaw}」は形式が正しくないため無視し、新しいタスクとして扱います`);
      else if (idLine.has(idRaw)) err(`ID「${idRaw}」が${idLine.get(idRaw)}行目と重複しています`);
      else {
        idLine.set(idRaw, line);
        id = idRaw;
      }
    }

    let discipline: Discipline = 'OTHER';
    const discRaw = get('discipline');
    if (norm(discRaw)) {
      const d = DISC_ALIASES[key(discRaw)];
      if (d) discipline = d;
      else err(`工種「${norm(discRaw)}」は不明です（設計/調達/施工/その他 または E/P/C）`);
    }

    let isMilestone = false;
    const msRaw = key(get('milestone'));
    if (msRaw) {
      if (TRUE_WORDS.includes(msRaw)) isMilestone = true;
      else if (!FALSE_WORDS.includes(msRaw))
        err(`マイルストーン「${norm(get('milestone'))}」は不明です（○ または空欄）`);
    }

    let durationDays = 0;
    const durRaw = norm(get('duration')).replace(/(営業日|日|days?|d)$/i, '');
    if (durRaw) {
      const n = parseNumber(durRaw);
      if (n == null || n < 0 || n > MAX_DAYS) err(`所要日数「${norm(get('duration'))}」は 0〜${MAX_DAYS} の数値にしてください`);
      else durationDays = n;
    } else if (!isMilestone && hasCol('duration')) {
      warnings.push(`${line}行目: 所要日数が空のため 0 日として取り込みました`);
    }

    let status: Status | null = null;
    const stRaw = get('status');
    if (norm(stRaw)) {
      status = STATUS_ALIASES[key(stRaw)] ?? null;
      if (!status) err(`ステータス「${norm(stRaw)}」は不明です（未着手/進行中/完了/保留）`);
    }

    let progress: number | null = null;
    const pgRaw = norm(get('progress'));
    if (pgRaw) {
      const pct = pgRaw.endsWith('%');
      const n = parseNumber(pct ? pgRaw.slice(0, -1) : pgRaw);
      // Excel のパーセント書式が小数(0.3)で出た場合は割合として扱う。
      const v = n == null ? null : !pct && n > 0 && n < 1 ? n * 100 : n;
      if (v == null || v < 0 || v > 100) err(`進捗「${pgRaw}」は 0〜100 にしてください`);
      else progress = Math.round(v);
    }
    if (!status) status = progress === 100 ? 'DONE' : progress ? 'IN_PROGRESS' : 'NOT_STARTED';
    if (progress == null) progress = status === 'DONE' ? 100 : 0;

    const startRaw = norm(get('start'));
    const deadlineRaw = norm(get('deadline'));
    const start = startRaw ? parseCsvDate(startRaw) : null;
    const deadline = deadlineRaw ? parseCsvDate(deadlineRaw) : null;
    if (startRaw && !start) err(`開始日「${startRaw}」を日付として読めません（例: 2026/4/1）`);
    if (deadlineRaw && !deadline) err(`期限「${deadlineRaw}」を日付として読めません（例: 2026/12/25）`);
    if (start && deadline) err('開始日と期限は同じ行に両方は指定できません（どちらか一方にしてください）');

    const asRaw = norm(get('actualStart'));
    const afRaw = norm(get('actualFinish'));
    const actualStart = asRaw ? parseCsvDate(asRaw) : null;
    const actualFinish = afRaw ? parseCsvDate(afRaw) : null;
    if (asRaw && !actualStart) err(`実績開始日「${asRaw}」を日付として読めません（例: 2026/4/1）`);
    if (afRaw && !actualFinish) err(`実績完了日「${afRaw}」を日付として読めません（例: 2026/4/30）`);
    if (actualStart && actualFinish && actualFinish < actualStart) err('実績完了日が実績開始日より前です');

    if (errors.length > errCount) continue;
    if (start && (!earliestStart || start < earliestStart)) earliestStart = start;
    const task = makeTask(
      {
        ...(id ? { id } : {}),
        wbsCode: wbs,
        name,
        discipline,
        isMilestone,
        durationDays,
        status,
        progress,
        assignee: unguardText(get('assignee').trim()),
        constraintType: start ? 'SNET' : deadline ? 'FNLT' : 'ASAP',
        constraintDate: start ?? deadline ?? null,
        notes: unguardText(get('notes').trim()),
      },
      by,
    );
    if (actualStart) task.actualStart = actualStart;
    if (actualFinish) task.actualFinish = actualFinish;
    row.task = task;
  }
  const parsed = all.filter((r): r is Row & { task: Task } => r.task != null);
  if (!hasCol('duration') && parsed.some((p) => !p.task.isMilestone)) {
    warnings.push('「所要日数」列が無いため、所要日数は 0 日として扱います（現在のプロジェクトの更新では既存タスクの日数は変わりません）');
  }

  // 先行タスクの参照方法: No 列 → WBS（一意な場合）→ データ行の順番（見出しの次の行が 1）。
  const wbsValues = all.map((r) => r.wbs).filter(Boolean);
  const mode: 'no' | 'wbs' | 'row' = hasCol('no')
    ? 'no'
    : new Set(wbsValues).size === wbsValues.length
      ? 'wbs'
      : 'row';
  const refOf = (r: Row) => (mode === 'no' ? r.no : mode === 'wbs' ? r.wbs : String(r.seq));
  const toKey = mode === 'wbs' ? norm : noKey;
  // エラー行の参照先も「存在する」とみなし、二重のエラーを避ける。
  const known = new Set(all.map(refOf).filter(Boolean));
  const byRef = new Map(parsed.map((p) => [refOf(p), p.task]));
  if (mode === 'row' && parsed.some((p) => norm(p.predRaw))) {
    warnings.push(
      '「No」列が無く WBS が重複しているため、先行タスクの番号はデータ行の順番（見出しの次の行が 1）として読みました',
    );
  }

  const dependencies: Dependency[] = [];
  const pairs = new Set<string>();
  let unresolved = false;
  for (const p of parsed) {
    const tokens = p.predRaw.split(/[,、，;；\r\n]+/).map(norm).filter(Boolean);
    for (const tok of tokens) {
      const ref = parsePredToken(tok, known, toKey);
      if (!ref) {
        errors.push(`${p.line}行目: 先行タスク「${tok}」を解釈できません（例: 3 / 3FS+2 / 3SS-1）`);
        continue;
      }
      if (!known.has(ref.ref)) {
        errors.push(`${p.line}行目: 先行タスク「${ref.ref}」が見つかりません`);
        unresolved = true;
        continue;
      }
      const pred = byRef.get(ref.ref);
      if (!pred) continue;
      if (pred.id === p.task.id) {
        errors.push(`${p.line}行目: 自分自身を先行タスクにはできません`);
        continue;
      }
      const k = pred.id + '>' + p.task.id;
      if (pairs.has(k)) {
        warnings.push(`${p.line}行目: 先行タスク「${ref.ref}」が重複しているため1つにまとめました`);
        continue;
      }
      pairs.add(k);
      dependencies.push(makeDep(pred.id, p.task.id, { type: ref.type, lagDays: ref.lagDays }, by));
    }
  }
  if (unresolved && mode === 'no') {
    errors.push('先行タスクは「No」列の番号で指定してください（例: 3 / 3FS+2 / 3SS-1）');
  } else if (unresolved && mode === 'row') {
    errors.push(
      '「No」列が無く WBS が重複しているため、先行タスクはデータ行の順番（見出しの次の行が 1）で指定してください。「No」列を追加すると、その番号で指定できます',
    );
  }

  const tasks = parsed.map((p) => p.task);
  if (!errors.length) {
    const topo = topoSort(tasks, dependencies);
    if (!topo.ok) {
      const inOrder = new Set(topo.order);
      const loop = parsed.filter((p) => !inOrder.has(p.task.id)).map((p) => `${p.line}行目「${p.task.name}」`);
      errors.push(
        `先行タスクの指定が循環しています（関係する行: ${loop.slice(0, 8).join('、')}${loop.length > 8 ? ' ほか' : ''}）`,
      );
    }
  }
  if (!tasks.length && !errors.length) errors.push('取り込めるタスク行がありません');

  const owned = new Set<CsvTaskField>();
  for (const c of Object.keys(colIdx) as Col[]) for (const f of COL_FIELDS[c] ?? []) owned.add(f);
  return {
    tasks,
    dependencies,
    errors,
    warnings,
    earliestStart,
    fields: CSV_TASK_FIELDS.filter((f) => owned.has(f)),
    hasPredecessors: hasCol('pred'),
    hasIds: hasCol('id'),
  };
}

// ---- 出力（現在のプロジェクト → 標準テンプレート形式）----
const DISC_OUT: Record<Discipline, string> = { E: '設計', P: '調達', C: '施工', OTHER: 'その他' };
const STATUS_OUT: Record<Status, string> = {
  NOT_STARTED: '未着手',
  IN_PROGRESS: '進行中',
  DONE: '完了',
  ON_HOLD: '保留',
};
const slashDate = (iso: string) => iso.replace(/-/g, '/');

// WBS 順に並べ、No（1..n）を振って先行タスクを No で書き出す。末尾の ID は更新取込の突合キー。
export function toCsv(tasks: Task[], dependencies: Dependency[]): string {
  const sorted = [...tasks].sort((a, b) => naturalWbsCompare(a.wbsCode, b.wbsCode));
  const noOf = new Map(sorted.map((t, i) => [t.id, String(i + 1)]));
  const preds = new Map<string, string[]>();
  for (const d of dependencies) {
    const p = noOf.get(d.predecessorId);
    if (!p || !noOf.has(d.successorId)) continue;
    const lag = d.lagDays ? (d.lagDays > 0 ? '+' : '') + d.lagDays : '';
    const ref = d.type === 'FS' && !lag ? p : p + d.type + lag;
    const list = preds.get(d.successorId) ?? [];
    list.push(ref);
    preds.set(d.successorId, list);
  }
  const rows: string[][] = [[...CSV_COLUMNS]];
  for (const t of sorted) {
    rows.push([
      noOf.get(t.id)!,
      t.wbsCode,
      guardText(t.name),
      DISC_OUT[t.discipline],
      t.isMilestone ? '' : String(t.durationDays),
      t.isMilestone ? '○' : '',
      (preds.get(t.id) ?? []).join(','),
      STATUS_OUT[t.status],
      String(t.progress),
      guardText(t.assignee),
      t.constraintType === 'SNET' && t.constraintDate ? slashDate(t.constraintDate) : '',
      t.constraintType === 'FNLT' && t.constraintDate ? slashDate(t.constraintDate) : '',
      t.actualStart ? slashDate(t.actualStart) : '',
      t.actualFinish ? slashDate(t.actualFinish) : '',
      guardText(t.notes),
      guardText(t.id),
    ]);
  }
  return toCsvText(rows);
}

// 標準テンプレート（見出し＋記入例）。Excel で開いて記入例を上書きして使う。
export function csvTemplate(): string {
  const row = (cells: string[]) => [...cells, ...Array<string>(CSV_COLUMNS.length - cells.length).fill('')];
  return toCsvText([
    [...CSV_COLUMNS],
    row(['1', '1.1', '基本設計', '設計', '10', '', '', '完了', '100', '設計課', '2026/04/01']),
    row(['2', '1.2', '詳細設計', '設計', '15', '', '1', '進行中', '40', '設計課']),
    row(['3', '2.1', '主要機器発注', '調達', '5', '', '2SS+5', '未着手', '0', '調達課', '', '', '', '', '長納期品']),
    row(['4', '2.2', '機器納入', '調達', '60', '', '3', '未着手', '0', '調達課']),
    row(['5', '3.1', '基礎工事', '施工', '20', '', '2', '未着手', '0', '工事課']),
    row(['6', '3.2', '据付工事', '施工', '25', '', '4,5', '未着手', '0', '工事課']),
    row(['7', '3.3', '試運転完了', '施工', '', '○', '6', '未着手', '0', '工事課', '', '2026/12/25']),
  ]);
}
