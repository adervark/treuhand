/**
 * Schema as an append-only list of migrations, tracked with `PRAGMA user_version`.
 * `migrate()` is safe to run repeatedly: it applies only migrations the file
 * has not seen. To change the schema, append a new entry; never edit an old one.
 *
 * Enum values (states, kinds) are validated in TypeScript (src/lib/types.ts),
 * not with SQL CHECK constraints, so adding a value needs no table rebuild.
 */
import type Database from "better-sqlite3";

export const MIGRATIONS: readonly string[] = [
  // 1: initial schema: contracts, conditions, submissions, verdicts, ledger,
  // disputes, events, and the demo identities.
  `
  CREATE TABLE IF NOT EXISTS identities (
    role          TEXT PRIMARY KEY,           -- 'payer' | 'worker'
    display_name  TEXT NOT NULL,
    email         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id                       TEXT PRIMARY KEY,
    title                    TEXT NOT NULL,
    type                     TEXT NOT NULL,   -- ContractType
    payer_email              TEXT NOT NULL,
    worker_email             TEXT NOT NULL,
    amount_cents             INTEGER NOT NULL CHECK (amount_cents > 0),
    currency                 TEXT NOT NULL DEFAULT 'USD',
    deadline_at              TEXT NOT NULL,
    state                    TEXT NOT NULL DEFAULT 'DRAFT',  -- ContractState; written only by src/lib/contract/machine.ts
    payer_signed_at          TEXT,
    worker_signed_at         TEXT,
    paypal_order_id          TEXT,
    paypal_authorization_id  TEXT,
    paypal_capture_id        TEXT,
    paypal_payout_batch_id   TEXT,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS contracts_state ON contracts(state);

  CREATE TABLE IF NOT EXISTS conditions (
    id            TEXT PRIMARY KEY,
    contract_id   TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    position      INTEGER NOT NULL,
    text          TEXT NOT NULL,
    check_kind    TEXT NOT NULL,              -- CheckKind
    check_params  TEXT NOT NULL DEFAULT '{}', -- JSON
    UNIQUE (contract_id, position)
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id           TEXT PRIMARY KEY,
    contract_id  TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    url          TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS submissions_contract ON submissions(contract_id);

  CREATE TABLE IF NOT EXISTS verdicts (
    id             TEXT PRIMARY KEY,
    submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    condition_id   TEXT NOT NULL REFERENCES conditions(id),
    passed         INTEGER NOT NULL,          -- 0 | 1
    confidence     REAL NOT NULL,
    reasoning      TEXT NOT NULL,
    evidence       TEXT NOT NULL DEFAULT '{}', -- JSON: screenshot paths, API responses
    created_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS verdicts_submission ON verdicts(submission_id);

  CREATE TABLE IF NOT EXISTS ledger (
    id            TEXT PRIMARY KEY,
    contract_id   TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,              -- LedgerKind
    amount_cents  INTEGER NOT NULL,
    paypal_ref    TEXT,
    raw           TEXT NOT NULL DEFAULT '{}', -- JSON
    created_at    TEXT NOT NULL,
    UNIQUE (kind, paypal_ref)                 -- idempotent webhook / retry writes
  );
  CREATE INDEX IF NOT EXISTS ledger_contract ON ledger(contract_id);

  CREATE TABLE IF NOT EXISTS disputes (
    id                     TEXT PRIMARY KEY,
    contract_id            TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    opened_by              TEXT NOT NULL,     -- Party
    payer_argument         TEXT,
    worker_argument        TEXT,
    proposed_worker_cents  INTEGER,
    proposal_reasoning     TEXT,
    payer_accepted         INTEGER,           -- NULL = not answered, 0 | 1
    worker_accepted        INTEGER,
    state                  TEXT NOT NULL DEFAULT 'OPEN',  -- DisputeState
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS disputes_contract ON disputes(contract_id);

  CREATE TABLE IF NOT EXISTS events (
    id           TEXT PRIMARY KEY,
    contract_id  TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,               -- EventKind
    detail       TEXT NOT NULL DEFAULT '{}',  -- JSON
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_contract ON events(contract_id);
  `,
  // 2: per-contract action claim (src/lib/contract/service-claims.ts).
  // A service action that calls PayPal, the verifier or the mediator claims the
  // contract first, so two racing requests cannot capture or pay out twice.
  `
  ALTER TABLE contracts ADD COLUMN claim_action TEXT;  -- e.g. 'settle_pass'; NULL when free
  ALTER TABLE contracts ADD COLUMN claim_token  TEXT;  -- random id of the holder
  ALTER TABLE contracts ADD COLUMN claimed_at   TEXT;  -- ISO time; stale after a timeout
  `,
  // 3: signed verification receipts (src/lib/verifier/receipt.ts). terms_hash
  // is the SHA-256 of the canonical agreed terms, set when the contract
  // becomes SIGNED (or lazily for contracts signed before this migration).
  `
  ALTER TABLE contracts ADD COLUMN terms_hash TEXT;

  CREATE TABLE IF NOT EXISTS receipts (
    receipt_sha256  TEXT PRIMARY KEY,
    submission_id   TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    contract_id     TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    signed          TEXT NOT NULL,             -- JSON SignedReceipt, exactly as issued
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS receipts_contract ON receipts(contract_id);
  CREATE INDEX IF NOT EXISTS receipts_submission ON receipts(submission_id);
  `,
  // 4: agent API tokens (src/lib/agent/tokens.ts, created by scripts/agent-token.ts).
  // Only the SHA-256 of a token is stored; the token is shown once, at creation.
  `
  CREATE TABLE IF NOT EXISTS agent_tokens (
    id            TEXT PRIMARY KEY,
    token_sha256  TEXT NOT NULL UNIQUE,
    role          TEXT NOT NULL,              -- Party the token acts as
    scopes        TEXT NOT NULL DEFAULT '[]', -- JSON AgentScope[]: read, write, sign
    label         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    revoked_at    TEXT                        -- NULL while the token is valid
  );
  `,
  // 5: the verifier's work log (src/lib/verifier/trace-types.ts, src/lib/db/steps.ts):
  // one row per step of a verification run, inserted when the step starts and
  // updated when it ends, so the contract page can show a run in progress.
  `
  CREATE TABLE IF NOT EXISTS verification_steps (
    id             TEXT PRIMARY KEY,
    submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    condition_id   TEXT,                       -- NULL for run-level steps
    seq            INTEGER NOT NULL,           -- 1-based order of starting within the submission's run
    kind           TEXT NOT NULL,              -- TraceStepKind
    label          TEXT NOT NULL,
    status         TEXT NOT NULL,              -- 'running' | 'done' | 'failed'
    started_at     TEXT NOT NULL,
    duration_ms    INTEGER,                    -- NULL while running
    detail         TEXT NOT NULL DEFAULT '{}', -- JSON TraceFacts, safe to show mid-run
    result         TEXT NOT NULL DEFAULT '{}', -- JSON TraceFacts, shown once the check has its verdict
    UNIQUE (submission_id, seq)
  );
  `,
];

/** Applies pending migrations. Returns the resulting schema version. */
export function migrate(db: Database.Database): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return MIGRATIONS.length;
}
