/**
 * Shared domain types and zod schemas. Entity fields are snake_case so they
 * match the SQLite columns one to one.
 *
 * A new enum value or field is added here (and, for a column, a migration in
 * src/lib/db/schema.ts) so every module sees the same shape.
 */
import { z } from "zod";
import { CONTRACT_CURRENCY, MAX_AMOUNT_CENTS } from "./format";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const CONTRACT_STATES = [
  "DRAFT",
  "SIGNED",
  "FUNDED",
  "SUBMITTED",
  "VERIFYING",
  "PASSED",
  "FAILED",
  "PAID",
  "EXPIRED",
  "DISPUTED",
  "SETTLED",
  // A declined split: a person decides outside the app.
  "ESCALATED",
] as const;
export const ContractStateSchema = z.enum(CONTRACT_STATES);
export type ContractState = z.infer<typeof ContractStateSchema>;

export const CONTRACT_TYPES = ["code_bounty", "website_milestone"] as const;
export const ContractTypeSchema = z.enum(CONTRACT_TYPES);
export type ContractType = z.infer<typeof ContractTypeSchema>;

export const CHECK_KINDS = [
  "github_pr_merged",
  "github_checks_passed",
  "github_pr_references_issue",
  "http_ok",
  "dom_assert",
  "responsive",
  "form_submits",
  "ai_page_judgement",
] as const;
export const CheckKindSchema = z.enum(CHECK_KINDS);
export type CheckKind = z.infer<typeof CheckKindSchema>;

/** Which check kinds each contract type may use. */
export const CHECK_KINDS_BY_CONTRACT_TYPE: Record<ContractType, readonly CheckKind[]> = {
  code_bounty: ["github_pr_merged", "github_checks_passed", "github_pr_references_issue"],
  website_milestone: ["http_ok", "dom_assert", "responsive", "form_submits", "ai_page_judgement"],
};

export const PARTIES = ["payer", "worker"] as const;
export const PartySchema = z.enum(PARTIES);
export type Party = z.infer<typeof PartySchema>;

/** Who caused an event. Verifier, mediator and PayPal webhooks act as "system". */
export const ACTORS = ["payer", "worker", "system"] as const;
export const ActorSchema = z.enum(ACTORS);
export type Actor = z.infer<typeof ActorSchema>;

export const LEDGER_KINDS = ["AUTHORIZED", "CAPTURED", "PAID_OUT", "VOIDED", "REFUNDED"] as const;
export const LedgerKindSchema = z.enum(LEDGER_KINDS);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

/** The smallest set of dispute states the flow needs. */
export const DISPUTE_STATES = ["OPEN", "PROPOSED", "SETTLED", "ESCALATED"] as const;
export const DisputeStateSchema = z.enum(DISPUTE_STATES);
export type DisputeState = z.infer<typeof DisputeStateSchema>;

/** Event kinds written to the audit trail. */
export const EVENT_KINDS = [
  "CONTRACT_CREATED",
  "STATE_CHANGED",
  "SIGNED_OFF",
  "SIGNOFFS_CLEARED",
  "CONDITIONS_EDITED",
  "TERMS_EDITED",
  // Written by the contract service (src/lib/contract/service*.ts):
  "ORDER_CREATED",
  "FUNDS_AUTHORIZED",
  "SUBMISSION_RECEIVED",
  "VERIFICATION_STARTED",
  "VERIFICATION_COMPLETED",
  "VERIFICATION_ERROR",
  "FUNDS_CAPTURED",
  "PAYOUT_SENT",
  "AUTHORIZATION_VOIDED",
  "REFUND_SENT",
  "ACTION_FAILED",
  "DISPUTE_OPENED",
  "DISPUTE_ARGUMENT_ADDED",
  "DISPUTE_PROPOSED",
  "DISPUTE_ACCEPTED",
  "DISPUTE_DECLINED",
  // The drafter's notes on a contract created from a draft (detail.notes: string[]).
  "DRAFTER_NOTES",
  // A payout item's PayPal status changed (detail.status, detail.payout_batch_id).
  "PAYOUT_STATUS",
  // One per verified PayPal webhook (src/lib/paypal/webhook.ts), detail.event_id is PayPal's.
  "PAYPAL_WEBHOOK",
  // PayPal returned a payout's money (detail.payout_batch_id, detail.status); the share is
  // sent again as detail.attempt (of detail.max_attempts).
  "PAYOUT_RETRIED",
  // The last payout attempt came back too; the worker's share was refunded to the payer.
  "PAYOUT_ABANDONED",
] as const;
export const EventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindSchema>;

// ---------------------------------------------------------------------------
// Check params, one schema per check kind
// ---------------------------------------------------------------------------

const RepoSchema = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'expected "owner/name"');

/** Path appended to the submitted URL; defaults to the URL itself. */
const PagePathSchema = z.string().startsWith("/").optional();

export const CheckParamsSchemas = {
  github_pr_merged: z.object({ repo: RepoSchema }),
  github_checks_passed: z.object({ repo: RepoSchema }),
  github_pr_references_issue: z.object({ repo: RepoSchema, issue: z.number().int().positive() }),
  http_ok: z.object({ path: PagePathSchema }),
  dom_assert: z.object({
    path: PagePathSchema,
    selector: z.string().min(1),
    /** If set, the matched element must contain this text. */
    text: z.string().min(1).optional(),
  }),
  responsive: z.object({
    path: PagePathSchema,
    /** Viewport width in CSS pixels: a small phone (240) up to a 4K screen (3840). */
    width: z.number().int().min(240).max(3840).default(375),
  }),
  form_submits: z.object({
    path: PagePathSchema,
    form_selector: z.string().min(1),
    /** CSS selector -> value to fill. */
    fields: z.record(z.string(), z.string()),
    /** Text that must appear after submitting. */
    success_text: z.string().min(1),
  }),
  ai_page_judgement: z.object({
    path: PagePathSchema,
    /** The question the model answers about the rendered page. */
    criterion: z.string().min(1),
  }),
} as const satisfies Record<CheckKind, z.ZodType>;

export type CheckParams<K extends CheckKind = CheckKind> = z.infer<(typeof CheckParamsSchemas)[K]>;

/** A condition's check: the kind plus params validated against that kind. */
export const ConditionCheckSchema = z.discriminatedUnion("check_kind", [
  z.object({ check_kind: z.literal("github_pr_merged"), check_params: CheckParamsSchemas.github_pr_merged }),
  z.object({ check_kind: z.literal("github_checks_passed"), check_params: CheckParamsSchemas.github_checks_passed }),
  z.object({
    check_kind: z.literal("github_pr_references_issue"),
    check_params: CheckParamsSchemas.github_pr_references_issue,
  }),
  z.object({ check_kind: z.literal("http_ok"), check_params: CheckParamsSchemas.http_ok }),
  z.object({ check_kind: z.literal("dom_assert"), check_params: CheckParamsSchemas.dom_assert }),
  z.object({ check_kind: z.literal("responsive"), check_params: CheckParamsSchemas.responsive }),
  z.object({ check_kind: z.literal("form_submits"), check_params: CheckParamsSchemas.form_submits }),
  z.object({ check_kind: z.literal("ai_page_judgement"), check_params: CheckParamsSchemas.ai_page_judgement }),
]);
export type ConditionCheck = z.infer<typeof ConditionCheckSchema>;

// ---------------------------------------------------------------------------
// Entities (one per SQLite table)
// ---------------------------------------------------------------------------

const IdSchema = z.string().min(1);
const IsoDateSchema = z.iso.datetime();
const CentsSchema = z.number().int().nonnegative();
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ContractSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  type: ContractTypeSchema,
  payer_email: z.email(),
  worker_email: z.email(),
  amount_cents: z.number().int().positive(),
  currency: z.string().length(3),
  deadline_at: IsoDateSchema,
  state: ContractStateSchema,
  payer_signed_at: IsoDateSchema.nullable(),
  worker_signed_at: IsoDateSchema.nullable(),
  paypal_order_id: z.string().nullable(),
  paypal_authorization_id: z.string().nullable(),
  paypal_capture_id: z.string().nullable(),
  paypal_payout_batch_id: z.string().nullable(),
  created_at: IsoDateSchema,
  updated_at: IsoDateSchema,
});
export type Contract = z.infer<typeof ContractSchema>;

export type PaypalRefs = Pick<
  Contract,
  "paypal_order_id" | "paypal_authorization_id" | "paypal_capture_id" | "paypal_payout_batch_id"
>;

export const ConditionSchema = z
  .object({
    id: IdSchema,
    contract_id: IdSchema,
    position: z.number().int().nonnegative(),
    text: z.string().min(1),
  })
  .and(ConditionCheckSchema);
export type Condition = z.infer<typeof ConditionSchema>;

export const SubmissionSchema = z.object({
  id: IdSchema,
  contract_id: IdSchema,
  url: z.url(),
  created_at: IsoDateSchema,
});
export type Submission = z.infer<typeof SubmissionSchema>;

/**
 * What one check concluded. "inconclusive" means the check
 * could not complete (network error, timeout, rate limit, model error) or its
 * confidence was below the threshold: neither a pass nor a fail. Such a
 * verdict is stored with `passed: false` and `confidence: 0`.
 */
export const VERDICT_OUTCOMES = ["pass", "fail", "inconclusive"] as const;
export const VerdictOutcomeSchema = z.enum(VERDICT_OUTCOMES);
export type VerdictOutcome = z.infer<typeof VerdictOutcomeSchema>;

/** Evidence stored with a verdict: screenshot paths, API responses, anything else. */
export const VerdictEvidenceSchema = z
  .object({
    screenshots: z.array(z.string()).optional(),
    responses: z.array(z.unknown()).optional(),
    /** Absent on older rows, where it is "pass" if `passed` else "fail". */
    outcome: VerdictOutcomeSchema.optional(),
  })
  .catchall(z.unknown());
export type VerdictEvidence = z.infer<typeof VerdictEvidenceSchema>;

export const VerdictSchema = z.object({
  id: IdSchema,
  submission_id: IdSchema,
  condition_id: IdSchema,
  passed: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  evidence: VerdictEvidenceSchema,
  created_at: IsoDateSchema,
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const LedgerEntrySchema = z.object({
  id: IdSchema,
  contract_id: IdSchema,
  kind: LedgerKindSchema,
  amount_cents: CentsSchema,
  paypal_ref: z.string().nullable(),
  raw: z.unknown(),
  created_at: IsoDateSchema,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const DisputeSchema = z.object({
  id: IdSchema,
  contract_id: IdSchema,
  opened_by: PartySchema,
  payer_argument: z.string().nullable(),
  worker_argument: z.string().nullable(),
  proposed_worker_cents: CentsSchema.nullable(),
  proposal_reasoning: z.string().nullable(),
  /** null = not answered yet. */
  payer_accepted: z.boolean().nullable(),
  worker_accepted: z.boolean().nullable(),
  state: DisputeStateSchema,
  created_at: IsoDateSchema,
  updated_at: IsoDateSchema,
});
export type Dispute = z.infer<typeof DisputeSchema>;

export const EventSchema = z.object({
  id: IdSchema,
  contract_id: IdSchema,
  kind: EventKindSchema,
  detail: JsonObjectSchema,
  created_at: IsoDateSchema,
});
export type ClauseEvent = z.infer<typeof EventSchema>;
/** Alias matching the `events` table; `ClauseEvent` avoids shadowing the DOM `Event`. */
export type { ClauseEvent as Event };

export const IdentitySchema = z.object({
  role: PartySchema,
  display_name: z.string().min(1),
  email: z.email(),
});
export type Identity = z.infer<typeof IdentitySchema>;

// ---------------------------------------------------------------------------
// Inputs (validate API request bodies and AI output with these)
// ---------------------------------------------------------------------------

export const ConditionInputSchema = z.object({ text: z.string().min(1) }).and(ConditionCheckSchema);
export type ConditionInput = z.infer<typeof ConditionInputSchema>;

/** Most conditions one contract may have: each is a check run on every submission. */
export const MAX_CONDITIONS = 20;
export const ConditionInputListSchema = z
  .array(ConditionInputSchema)
  .max(MAX_CONDITIONS, `has more than ${MAX_CONDITIONS} conditions`);

const ContractTermsSchema = z.object({
  title: z.string().min(1),
  type: ContractTypeSchema,
  payer_email: z.email(),
  worker_email: z.email(),
  amount_cents: z.number().int().positive(),
  currency: z.string().length(3),
  deadline_at: IsoDateSchema,
});

export const NewContractInputSchema = ContractTermsSchema.extend({
  currency: z.string().length(3).default("USD"),
  conditions: ConditionInputListSchema.default([]),
});
export type NewContractInput = z.input<typeof NewContractInputSchema>;

/**
 * Editable contract terms while in DRAFT. Editing any of them clears both
 * sign-offs. Built without defaults so an omitted field stays unchanged.
 */
export const ContractTermsPatchSchema = ContractTermsSchema.partial().extend({
  // The same limits as creating over the API (CreateContractBody): USD only, at most MAX_AMOUNT_CENTS.
  amount_cents: z.number().int().positive().max(MAX_AMOUNT_CENTS).optional(),
  currency: z.literal(CONTRACT_CURRENCY).optional(),
});
export type ContractTermsPatch = z.infer<typeof ContractTermsPatchSchema>;
