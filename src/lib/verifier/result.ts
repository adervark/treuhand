/**
 * Building check results. Deterministic checks that reach a conclusion use
 * confidence 1. A check that could not complete is inconclusive: neither pass
 * nor fail, stored with `passed: false` and `confidence: 0`, and the reason in
 * `evidence.error`.
 */
import type { VerdictEvidence } from "@/lib/types";
import type { CheckResult } from "./index";

/** A pass below this confidence does not pay out: the verdict is inconclusive and goes to a human or a re-run. */
export const CONFIDENCE_THRESHOLD = 0.8;

export function pass(reasoning: string, evidence: VerdictEvidence, confidence = 1): CheckResult {
  return { passed: true, confidence, reasoning, evidence };
}

export function fail(reasoning: string, evidence: VerdictEvidence, confidence = 1): CheckResult {
  return { passed: false, confidence, reasoning, evidence };
}

export function inconclusive(reasoning: string, evidence: VerdictEvidence, error?: unknown): CheckResult {
  return {
    passed: false,
    confidence: 0,
    reasoning,
    inconclusive: true,
    evidence: error === undefined ? evidence : { ...evidence, error: describeError(error) },
  };
}

export function describeError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { name: error.name, message: error.message.split("\n")[0].slice(0, 500), ...(code ? { code: String(code) } : {}) };
  }
  return { name: "Error", message: String(error).slice(0, 500) };
}

/** Truncates untrusted text before it is stored as evidence. */
export function clip(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
