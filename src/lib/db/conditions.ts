import {
  CHECK_KINDS_BY_CONTRACT_TYPE,
  ConditionInputSchema,
  ConditionSchema,
  type Condition,
  type ConditionInput,
  type ContractType,
} from "@/lib/types";
import { getDb, newId } from "./index";

/** A condition whose check kind does not belong to the contract's type. */
export class InvalidConditionError extends Error {
  readonly code = "INVALID_CONDITION";
  constructor(message: string) {
    super(message);
    this.name = "InvalidConditionError";
  }
}

type ConditionRow = {
  id: string;
  contract_id: string;
  position: number;
  text: string;
  check_kind: string;
  check_params: string;
};

function fromRow(row: ConditionRow): Condition {
  return ConditionSchema.parse({ ...row, check_params: JSON.parse(row.check_params) });
}

/** Validates each condition and checks its kind is allowed for the contract type. */
export function parseConditionsForType(type: ContractType, conditions: unknown[]): ConditionInput[] {
  return conditions.map((raw, i) => {
    const condition = ConditionInputSchema.parse(raw);
    if (!CHECK_KINDS_BY_CONTRACT_TYPE[type].includes(condition.check_kind)) {
      throw new InvalidConditionError(
        `condition ${i + 1}: check kind "${condition.check_kind}" is not allowed for a ${type} contract`,
      );
    }
    return condition;
  });
}

/**
 * Replaces all of a contract's conditions, positions 0..n-1.
 * Internal: callers go through `createContract` or `editConditions` in the
 * state machine, which enforce sign-off clearing and immutability.
 */
export function replaceConditionRows(contractId: string, conditions: ConditionInput[]): void {
  const db = getDb();
  db.prepare(`DELETE FROM conditions WHERE contract_id = ?`).run(contractId);
  const insert = db.prepare(
    `INSERT INTO conditions (id, contract_id, position, text, check_kind, check_params)
     VALUES (@id, @contract_id, @position, @text, @check_kind, @check_params)`,
  );
  conditions.forEach((c, position) => {
    insert.run({
      id: newId(),
      contract_id: contractId,
      position,
      text: c.text,
      check_kind: c.check_kind,
      check_params: JSON.stringify(c.check_params),
    });
  });
}

/** In position order. */
export function listConditions(contractId: string): Condition[] {
  const rows = getDb()
    .prepare(`SELECT * FROM conditions WHERE contract_id = ? ORDER BY position`)
    .all(contractId) as ConditionRow[];
  return rows.map(fromRow);
}

export function getCondition(id: string): Condition | null {
  const row = getDb().prepare(`SELECT * FROM conditions WHERE id = ?`).get(id) as ConditionRow | undefined;
  return row ? fromRow(row) : null;
}
