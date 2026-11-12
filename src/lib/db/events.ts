import { EventSchema, type ClauseEvent, type EventKind } from "@/lib/types";
import { getDb, newId, nowIso } from "./index";

type EventRow = Omit<ClauseEvent, "detail"> & { detail: string };

function fromRow(row: EventRow): ClauseEvent {
  return EventSchema.parse({ ...row, detail: JSON.parse(row.detail) });
}

/** Appends to a contract's audit trail. State changes record theirs via the machine. */
export function recordEvent(input: {
  contract_id: string;
  kind: EventKind;
  detail?: Record<string, unknown>;
}): ClauseEvent {
  const row: EventRow = {
    id: newId(),
    contract_id: input.contract_id,
    kind: input.kind,
    detail: JSON.stringify(input.detail ?? {}),
    created_at: nowIso(),
  };
  getDb()
    .prepare(
      `INSERT INTO events (id, contract_id, kind, detail, created_at)
       VALUES (@id, @contract_id, @kind, @detail, @created_at)`,
    )
    .run(row);
  return fromRow(row);
}

/** Oldest first. */
export function listEvents(contractId: string): ClauseEvent[] {
  const rows = getDb()
    .prepare(`SELECT * FROM events WHERE contract_id = ? ORDER BY created_at, rowid`)
    .all(contractId) as EventRow[];
  return rows.map(fromRow);
}
