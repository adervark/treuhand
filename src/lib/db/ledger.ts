import { LedgerEntrySchema, type LedgerEntry, type LedgerKind } from "@/lib/types";
import { getDb, newId, nowIso } from "./index";

type LedgerRow = Omit<LedgerEntry, "raw"> & { raw: string };

function fromRow(row: LedgerRow): LedgerEntry {
  return LedgerEntrySchema.parse({ ...row, raw: JSON.parse(row.raw) });
}

/**
 * Records a money movement. Idempotent on (kind, paypal_ref): recording the
 * same PayPal reference twice (a webhook retry, a request racing its webhook)
 * returns the existing row instead of adding a second one.
 */
export function recordLedgerEntry(input: {
  contract_id: string;
  kind: LedgerKind;
  amount_cents: number;
  paypal_ref: string | null;
  raw?: unknown;
}): LedgerEntry {
  const db = getDb();
  const row: LedgerRow = {
    id: newId(),
    contract_id: input.contract_id,
    kind: input.kind,
    amount_cents: input.amount_cents,
    paypal_ref: input.paypal_ref,
    raw: JSON.stringify(input.raw ?? {}),
    created_at: nowIso(),
  };
  const entry = fromRow(row); // validates before writing
  const result = db
    .prepare(
      `INSERT INTO ledger (id, contract_id, kind, amount_cents, paypal_ref, raw, created_at)
       VALUES (@id, @contract_id, @kind, @amount_cents, @paypal_ref, @raw, @created_at)
       ON CONFLICT (kind, paypal_ref) DO NOTHING`,
    )
    .run(row);
  if (result.changes === 0) {
    return fromRow(
      db.prepare(`SELECT * FROM ledger WHERE kind = ? AND paypal_ref = ?`).get(row.kind, row.paypal_ref) as LedgerRow,
    );
  }
  return entry;
}

export function getLedgerEntry(id: string): LedgerEntry | null {
  const row = getDb().prepare(`SELECT * FROM ledger WHERE id = ?`).get(id) as LedgerRow | undefined;
  return row ? fromRow(row) : null;
}

/** Oldest first; all contracts unless `contract_id` is given. */
export function listLedgerEntries(filter: { contract_id?: string } = {}): LedgerEntry[] {
  const db = getDb();
  const rows = (
    filter.contract_id
      ? db.prepare(`SELECT * FROM ledger WHERE contract_id = ? ORDER BY created_at, rowid`).all(filter.contract_id)
      : db.prepare(`SELECT * FROM ledger ORDER BY created_at, rowid`).all()
  ) as LedgerRow[];
  return rows.map(fromRow);
}
