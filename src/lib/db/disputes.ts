import { DisputeSchema, type Dispute, type Party } from "@/lib/types";
import { buildSetClause, fromSqlBool, getDb, newId, nowIso, toSqlBool } from "./index";

type DisputeRow = Omit<Dispute, "payer_accepted" | "worker_accepted"> & {
  payer_accepted: number | null;
  worker_accepted: number | null;
};

function fromRow(row: DisputeRow): Dispute {
  return DisputeSchema.parse({
    ...row,
    payer_accepted: fromSqlBool(row.payer_accepted),
    worker_accepted: fromSqlBool(row.worker_accepted),
  });
}

export type DisputePatch = Partial<
  Pick<
    Dispute,
    | "payer_argument"
    | "worker_argument"
    | "proposed_worker_cents"
    | "proposal_reasoning"
    | "payer_accepted"
    | "worker_accepted"
    | "state"
  >
>;

const PATCH_COLUMNS = [
  "payer_argument",
  "worker_argument",
  "proposed_worker_cents",
  "proposal_reasoning",
  "payer_accepted",
  "worker_accepted",
  "state",
] as const satisfies readonly (keyof DisputePatch)[];

/** Opens a dispute record in state OPEN. Moving the contract to DISPUTED is the machine's job. */
export function createDispute(input: {
  contract_id: string;
  opened_by: Party;
  payer_argument?: string | null;
  worker_argument?: string | null;
}): Dispute {
  const ts = nowIso();
  const dispute = DisputeSchema.parse({
    id: newId(),
    contract_id: input.contract_id,
    opened_by: input.opened_by,
    payer_argument: input.payer_argument ?? null,
    worker_argument: input.worker_argument ?? null,
    proposed_worker_cents: null,
    proposal_reasoning: null,
    payer_accepted: null,
    worker_accepted: null,
    state: "OPEN",
    created_at: ts,
    updated_at: ts,
  });
  getDb()
    .prepare(
      `INSERT INTO disputes (id, contract_id, opened_by, payer_argument, worker_argument, proposed_worker_cents,
                             proposal_reasoning, payer_accepted, worker_accepted, state, created_at, updated_at)
       VALUES (@id, @contract_id, @opened_by, @payer_argument, @worker_argument, @proposed_worker_cents,
               @proposal_reasoning, NULL, NULL, @state, @created_at, @updated_at)`,
    )
    .run(dispute);
  return dispute;
}

export function getDispute(id: string): Dispute | null {
  const row = getDb().prepare(`SELECT * FROM disputes WHERE id = ?`).get(id) as DisputeRow | undefined;
  return row ? fromRow(row) : null;
}

/** Oldest first. */
export function listDisputes(contractId: string): Dispute[] {
  const rows = getDb()
    .prepare(`SELECT * FROM disputes WHERE contract_id = ? ORDER BY created_at, rowid`)
    .all(contractId) as DisputeRow[];
  return rows.map(fromRow);
}

/** The newest dispute that is still OPEN or PROPOSED, if any. */
export function getActiveDispute(contractId: string): Dispute | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM disputes WHERE contract_id = ? AND state IN ('OPEN', 'PROPOSED')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(contractId) as DisputeRow | undefined;
  return row ? fromRow(row) : null;
}

export function updateDispute(id: string, patch: DisputePatch): Dispute {
  const current = getDispute(id);
  if (!current) throw new Error(`dispute ${id} not found`);
  const next = DisputeSchema.parse({ ...current, ...patch, updated_at: nowIso() });
  const set = buildSetClause(patch, PATCH_COLUMNS);
  if (set) {
    getDb()
      .prepare(`UPDATE disputes SET ${set}, updated_at = @updated_at WHERE id = @id`)
      .run({
        ...next,
        payer_accepted: toSqlBool(next.payer_accepted),
        worker_accepted: toSqlBool(next.worker_accepted),
      });
  }
  return getDispute(id)!;
}
