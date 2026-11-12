/**
 * SQLite connection. One shared better-sqlite3 handle per process, opened on
 * first use and migrated on open, so `getDb()` always returns a ready schema.
 *
 * File: `data/clause.db` under the working directory, or `CLAUSE_DB_PATH`
 * (tests point this at a temp file; `:memory:` also works).
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { migrate, MIGRATIONS } from "./schema";

export type Db = Database.Database;

// Kept on globalThis so Next.js dev reloads reuse the handle instead of leaking one per reload.
// `version` is the migration count the handle was migrated to; a reload that brings new
// migrations applies them to the reused handle (older handles have no `version`).
const globalForDb = globalThis as typeof globalThis & {
  __clauseDb?: { file: string; db: Db; version?: number };
};

export function dbPath(): string {
  return process.env.CLAUSE_DB_PATH || path.join(process.cwd(), "data", "clause.db");
}

export function getDb(): Db {
  const file = dbPath();
  const cached = globalForDb.__clauseDb;
  if (cached && cached.file === file && cached.db.open) {
    if (cached.version !== MIGRATIONS.length) cached.version = migrate(cached.db);
    return cached.db;
  }
  if (cached?.db.open) cached.db.close();

  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const version = migrate(db);
  globalForDb.__clauseDb = { file, db, version };
  return db;
}

export function closeDb(): void {
  const cached = globalForDb.__clauseDb;
  if (cached?.db.open) cached.db.close();
  globalForDb.__clauseDb = undefined;
}

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** SQLite stores booleans as 0/1. */
export function toSqlBool(value: boolean | null): 0 | 1 | null {
  return value === null ? null : value ? 1 : 0;
}

export function fromSqlBool(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

/**
 * Builds `col = @col, ...` for the keys of `patch` that are in `allowed`,
 * skipping undefined values. Returns null when nothing would change.
 */
export function buildSetClause<K extends string>(
  patch: Partial<Record<K, unknown>>,
  allowed: readonly K[],
): string | null {
  const cols = allowed.filter((col) => patch[col] !== undefined);
  return cols.length === 0 ? null : cols.map((col) => `${col} = @${col}`).join(", ");
}
