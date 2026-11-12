/**
 * Request body schemas for the API routes (docs/api.md). Messages leave out
 * the field name: the error message is "<field path>: <message>".
 */
import { z } from "zod";
import { CONTRACT_CURRENCY, formatCents, MAX_AMOUNT_CENTS } from "@/lib/format";
import { ConditionInputListSchema, ContractTypeSchema } from "@/lib/types";

const required =
  (why?: string) =>
  (issue: { input: unknown }): string | undefined =>
    issue.input === null || issue.input === undefined ? `is required${why ? ` (${why})` : ""}` : undefined;

const text = (max: number) =>
  z
    .string({ error: required() })
    .trim()
    .min(1, "is empty")
    .max(max, `is over ${max} characters`);

export const DraftBody = z.object({
  prompt: text(4000),
  type: ContractTypeSchema.optional(),
});

export const ConditionsSchema = ConditionInputListSchema.min(1, "needs at least one condition");

/** A ProposedContract from the drafter, possibly edited; every term must be filled in. */
export const CreateContractBody = z.object({
  title: text(200),
  type: ContractTypeSchema,
  amount_cents: z
    .number({ error: required("the deal did not state an amount") })
    .int("must be whole cents")
    .positive("must be more than 0")
    .max(MAX_AMOUNT_CENTS, `must be at most ${MAX_AMOUNT_CENTS} (${formatCents(MAX_AMOUNT_CENTS, CONTRACT_CURRENCY)}, the most one contract may hold)`),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((value) => value === CONTRACT_CURRENCY, `must be ${CONTRACT_CURRENCY}: contracts are paid in US dollars only`)
    .nullish()
    .transform((value) => value ?? CONTRACT_CURRENCY),
  deadline_at: z.iso.datetime({
    offset: true,
    error: (issue) =>
      issue.input === null || issue.input === undefined
        ? "is required (the deal did not state a deadline)"
        : "must be an ISO 8601 date-time",
  }),
  conditions: ConditionsSchema,
  notes: z.array(z.string()).default([]),
});

export const EditConditionsBody = z.object({ conditions: ConditionsSchema });

export const AuthorizeBody = z.object({ orderId: text(64) });

export const SubmitBody = z.object({
  url: z.url({
    protocol: /^https?$/,
    error: (issue) =>
      issue.input === null || issue.input === undefined ? "is required" : "must be an http or https URL",
  }),
});

export const ArgumentBody = z.object({ argument: text(4000) });

export const AcceptBody = z.object({ accept: z.boolean().default(true) });
