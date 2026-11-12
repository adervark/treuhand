/**
 * Domain errors raised by the contract service. Route handlers map `code` to
 * an HTTP status (src/app/api/_lib/http.ts); docs/api.md lists every code.
 * Errors from the state machine (ContractMachineError), the conditions module
 * (InvalidConditionError), zod and env (MissingEnvError) pass through as-is.
 */

export const SERVICE_ERROR_CODES = [
  "VALIDATION_ERROR",
  "FORBIDDEN",
  "NOT_FOUND",
  "ILLEGAL_TRANSITION",
  "DEADLINE_PASSED",
  "ORDER_MISMATCH",
  "BUSY",
  "DISPUTE_STATE",
  "IDENTITIES_MISSING",
  // The page sent a role (X-Treuhand-Role) other than the view-as cookie's: another tab switched it.
  "ROLE_MISMATCH",
  "PAYPAL_ERROR",
  "AI_ERROR",
] as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ServiceError";
  }
}

/** A reason an action is not allowed right now; null means allowed. */
export type Denial = { code: ServiceErrorCode; message: string } | null;

export function throwIfDenied(denial: Denial): void {
  if (denial) throw new ServiceError(denial.code, denial.message);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
