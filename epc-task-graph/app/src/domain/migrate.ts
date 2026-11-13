// ============================================================================
// スキーマ移行（schemaVersion）。保存データ/インポートJSONを現行版へ段階的に引き上げる。
// MIGRATIONS[v] は「版 v の doc → 版 v+1 の doc」を返す純関数。スキーマを変える時は
// CURRENT_SCHEMA_VERSION を上げ、対応する移行を追加する（既存の移行は書き換えない）。
// ============================================================================
export const CURRENT_SCHEMA_VERSION = 1;

type DocRecord = Record<string, unknown>;
export type Migration = (doc: DocRecord) => DocRecord;

export const MIGRATIONS: Record<number, Migration> = {};

export interface MigrateResult {
  doc: unknown;
  migrated: boolean;
}

export class NewerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NewerSchemaError';
  }
}

export function migrateDoc(
  raw: unknown,
  migrations: Record<number, Migration> = MIGRATIONS,
  current: number = CURRENT_SCHEMA_VERSION,
): MigrateResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { doc: raw, migrated: false };
  let doc = raw as DocRecord;
  let version = typeof doc.schemaVersion === 'number' ? doc.schemaVersion : 1;
  if (version > current) {
    throw new NewerSchemaError(
      `このデータは新しいバージョンのアプリで作成されています（データ v${version} / 対応 v${current}）。アプリを最新版に更新してください。`,
    );
  }
  let migrated = false;
  while (version < current) {
    const step = migrations[version];
    if (!step) throw new Error(`スキーマ v${version} から v${current} への移行手順がありません。`);
    doc = { ...step(doc), schemaVersion: version + 1 };
    version += 1;
    migrated = true;
  }
  return { doc, migrated };
}
