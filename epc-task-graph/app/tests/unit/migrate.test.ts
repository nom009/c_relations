import { describe, it, expect } from "vitest";
import { CURRENT_SCHEMA_VERSION, NewerSchemaError, migrateDoc } from "../../src/domain/migrate";

describe("migrateDoc", () => {
  it("treats a missing schemaVersion as v1 and leaves a current doc untouched", () => {
    const raw = { tasks: [] };
    const r = migrateDoc(raw);
    expect(r.migrated).toBe(false);
    expect(r.doc).toBe(raw);
  });

  it("returns non-object input unchanged", () => {
    expect(migrateDoc(null)).toEqual({ doc: null, migrated: false });
    expect(migrateDoc("x")).toEqual({ doc: "x", migrated: false });
  });

  it("throws a Japanese error for a doc newer than the app", () => {
    expect(() => migrateDoc({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 })).toThrow(NewerSchemaError);
    expect(() => migrateDoc({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 })).toThrow(/新しいバージョン/);
  });

  it("applies injected migrations in order and stamps schemaVersion", () => {
    const calls: number[] = [];
    const migrations = {
      1: (d: Record<string, unknown>) => {
        calls.push(1);
        return { ...d, a: true };
      },
      2: (d: Record<string, unknown>) => {
        calls.push(2);
        return { ...d, b: d.a === true };
      },
    };
    const r = migrateDoc({ schemaVersion: 1, tasks: [] }, migrations, 3);
    expect(calls).toEqual([1, 2]);
    expect(r.migrated).toBe(true);
    expect(r.doc).toEqual({ schemaVersion: 3, tasks: [], a: true, b: true });
  });

  it("starts from the doc's own version and fails when a step is missing", () => {
    const calls: number[] = [];
    const migrations = {
      2: (d: Record<string, unknown>) => {
        calls.push(2);
        return d;
      },
    };
    expect(migrateDoc({ schemaVersion: 2 }, migrations, 3).doc).toEqual({ schemaVersion: 3 });
    expect(calls).toEqual([2]);
    expect(() => migrateDoc({ schemaVersion: 1 }, migrations, 3)).toThrow(/移行手順/);
  });
});
