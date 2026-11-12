/**
 * Browser-side calls to the Clause API (docs/api.md). Errors keep
 * the API's own `{ error: { code, message } }` words so pages can show them
 * as they are; a route that does not exist yet says so plainly.
 */
import type { DraftResult, ProposedContract, VagueCondition } from "@/lib/ai/drafter";
import type { AllowedAction, ContractDetail, LedgerRow, PayoutStatus } from "@/lib/contract/service";
import type { Contract } from "@/lib/types";

// Type-only re-exports: nothing from the server modules reaches the browser bundle.
export type { AllowedAction, DraftResult, LedgerRow, PayoutStatus, ProposedContract, VagueCondition };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Everything `GET /api/contracts/[id]` returns (docs/api.md). */
export type ContractBundle = ContractDetail;

export interface SweepResult {
  expired: Contract[];
  settled: Contract[];
  errors: { contract_id: string; action: string; code: string; message: string }[];
}

/** Fired on `window` when the server says another tab switched the role; `RoleSync` refreshes the page. */
export const ROLE_CHANGED_EVENT = "proviso:role-changed";

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  // The role this page was rendered for (`data-viewer` on <html>); the server refuses a write
  // when the shared view-as cookie names the other role (X-Proviso-Role, docs/api.md).
  const shown = typeof document === "undefined" ? undefined : document.documentElement.dataset.viewer;
  if (shown) headers["X-Proviso-Role"] = shown;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      cache: "no-store",
      signal: init.signal,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(`Could not reach the server (${method} ${path}).`, 0, "NETWORK");
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    if (error?.code === "ROLE_MISMATCH" && typeof window !== "undefined") window.dispatchEvent(new Event(ROLE_CHANGED_EVENT));
    if (error?.message) throw new ApiError(error.message, res.status, error.code ?? `HTTP_${res.status}`);
    if (res.status === 404 && data === null) {
      throw new ApiError(`${method} ${path} is not available yet (404).`, 404, "ROUTE_MISSING");
    }
    throw new ApiError(`${method} ${path} failed: ${res.status} ${res.statusText}`.trim(), res.status, `HTTP_${res.status}`);
  }
  if (data === null) throw new ApiError(`${method} ${path} returned no JSON.`, res.status, "BAD_RESPONSE");
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
