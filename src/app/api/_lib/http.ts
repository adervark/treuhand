/**
 * Shared plumbing for the route handlers: JSON bodies validated with zod, and
 * every error mapped to `{ error: { code, message } }` with the status listed
 * in docs/api.md "Error codes".
 */
import { z } from "zod";
import { AgentAuthError } from "@/lib/agent/tokens";
import { ContractMachineError } from "@/lib/contract/machine";
import { ServiceError, type ServiceErrorCode } from "@/lib/contract/service";
import { InvalidConditionError } from "@/lib/db/conditions";
import { MissingEnvError } from "@/lib/env";

export type ErrorCode =
  | ServiceErrorCode
  | "INVALID_CONDITION"
  | "CONTRACT_LOCKED"
  | "NOT_CONFIGURED"
  | "INTERNAL"
  // An agent bearer token that is malformed, unknown or revoked (src/lib/agent/tokens.ts).
  | "UNAUTHORIZED";

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_CONDITION: 422,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  CONTRACT_LOCKED: 409,
  DEADLINE_PASSED: 409,
  ORDER_MISMATCH: 409,
  BUSY: 409,
  DISPUTE_STATE: 409,
  IDENTITIES_MISSING: 409,
  ROLE_MISMATCH: 409,
  PAYPAL_ERROR: 502,
  AI_ERROR: 502,
  NOT_CONFIGURED: 503,
  INTERNAL: 500,
  UNAUTHORIZED: 401,
};

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function errorResponse(code: ErrorCode, message: string): Response {
  return json({ error: { code, message } }, ERROR_STATUS[code]);
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}

/** Maps any thrown value to the API's error response. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof ServiceError) return errorResponse(err.code, err.message);
  if (err instanceof ContractMachineError) {
    return errorResponse(err.code, err.code === "NOT_FOUND" ? "No contract with that id." : err.message);
  }
  if (err instanceof InvalidConditionError) return errorResponse("INVALID_CONDITION", err.message);
  if (err instanceof z.ZodError) return errorResponse("VALIDATION_ERROR", zodMessage(err));
  if (err instanceof MissingEnvError) return errorResponse("NOT_CONFIGURED", err.message);
  if (err instanceof AgentAuthError) return errorResponse(err.code, err.message);
  console.error("Unhandled error in API route", err);
  return errorResponse("INTERNAL", "Something went wrong on the server. Reload the contract to see its current state.");
}

/** Runs a handler body and turns whatever it throws into an error response. */
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * Reads and validates a JSON body. An empty body is read as `{}`, so schemas
 * whose fields are all optional accept a request with no body.
 */
export async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const text = await request.text();
  let data: unknown = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ServiceError("VALIDATION_ERROR", "The request body is not valid JSON.");
    }
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ServiceError("VALIDATION_ERROR", zodMessage(parsed.error));
  return parsed.data;
}
