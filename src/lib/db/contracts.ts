/**
 * Contract rows. State and sign-off columns are deliberately not writable
 * here: they change only through src/lib/contract/machine.ts.
 */
import {
  ContractSchema,
  NewContractInputSchema,
  type Actor,
  type Contract,
  type ContractState,
  type NewContractInput,
  type PaypalRefs,
} from "@/lib/types";
import { parseConditionsForType, replaceConditionRows } from "./conditions";
import { recordEvent } from "./events";
import { buildSetClause, getDb, newId, nowIso } from "./index";

export const PAYPAL_REF_COLUMNS = [
  "paypal_order_id",
  "paypal_authorization_id",
  "paypal_capture_id",
  "paypal_payout_batch_id",
] as const satisfies readonly (keyof PaypalRefs)[];

function fromRow(row: unknown): Contract {
  return ContractSchema.parse(row);
}

/** Creates a DRAFT contract (and its conditions, if given) with no sign-offs. */
export function createContract(input: NewContractInput, actor: Actor = "payer"): Contract {
  const data = NewContractInputSchema.parse(input);
  const conditions = parseConditionsForType(data.type, data.conditions);
  const db = getDb();
  const id = newId();
  const ts = nowIso();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO contracts (id, title, type, payer_email, worker_email, amount_cents, currency,
                              deadline_at, state, created_at, updated_at)
       VALUES (@id, @title, @type, @payer_email, @worker_email, @amount_cents, @currency,
               @deadline_at, 'DRAFT', @ts, @ts)`,
    ).run({
      id,
      title: data.title,
      type: data.type,
      payer_email: data.payer_email,
      worker_email: data.worker_email,
      amount_cents: data.amount_cents,
      currency: data.currency,
      deadline_at: data.deadline_at,
      ts,
    });
    replaceConditionRows(id, conditions);
    recordEvent({ contract_id: id, kind: "CONTRACT_CREATED", detail: { actor, title: data.title } });
  })();

  return getContract(id)!;
}

export function getContract(id: string): Contract | null {
  const row = getDb().prepare(`SELECT * FROM contracts WHERE id = ?`).get(id);
  return row ? fromRow(row) : null;
}

/** Newest first. `email` matches either party. */
export function listContracts(filter: { state?: ContractState; email?: string } = {}): Contract[] {
  const where: string[] = [];
  if (filter.state) where.push("state = @state");
  if (filter.email) where.push("(payer_email = @email OR worker_email = @email)");
  const sql = `SELECT * FROM contracts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC, rowid DESC`;
  return getDb()
    .prepare(sql)
    .all({ state: filter.state ?? null, email: filter.email ?? null })
    .map(fromRow);
}

/**
 * Stores PayPal references without changing state (e.g. the order id while
 * the payer approves). To store them together with a state change, pass them
 * to `transition()` in the state machine instead.
 */
export function setPaypalRefs(id: string, refs: Partial<PaypalRefs>): Contract {
  const set = buildSetClause(refs, PAYPAL_REF_COLUMNS);
  if (set) {
    const result = getDb()
      .prepare(`UPDATE contracts SET ${set}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...refs, updated_at: nowIso(), id });
    if (result.changes === 0) throw new Error(`contract ${id} not found`);
  }
  const contract = getContract(id);
  if (!contract) throw new Error(`contract ${id} not found`);
  return contract;
}
