/**
 * Presentation vocabulary shared by every page: how states, ledger kinds,
 * check kinds and actors are named and coloured. Pure; safe on server and client.
 */
import type { Actor, CheckKind, ContractState, ContractType, LedgerKind } from "@/lib/types";

export { formatCents } from "@/lib/format";

/**
 * The colour vocabulary (docs/design.md, Colour). Every tone is also carried by
 * a word or glyph wherever it is shown. "info", "money", "pass" and "warn" are
 * older names kept as aliases of machine, paid, paid and disputed.
 */
export type Tone =
  | "neutral"
  | "held"
  | "paid"
  | "returned"
  | "fail"
  | "inconclusive"
  | "disputed"
  | "machine"
  | "payer"
  | "worker"
  | "info"
  | "money"
  | "pass"
  | "warn";

export const STATE_META: Record<ContractState, { label: string; tone: Tone; blurb: string }> = {
  DRAFT: { label: "Draft", tone: "neutral", blurb: "Both parties review the terms and tests, then sign." },
  SIGNED: { label: "Signed", tone: "neutral", blurb: "Both signed. Waiting for the payer to fund it." },
  FUNDED: { label: "Funded", tone: "held", blurb: "PayPal is holding the money. Waiting for the work." },
  SUBMITTED: { label: "Submitted", tone: "machine", blurb: "Work submitted. The verifier is about to start." },
  VERIFYING: { label: "Verifying", tone: "machine", blurb: "The verifier is checking each test against the work." },
  PASSED: { label: "Passed", tone: "paid", blurb: "Every test passed. PayPal is paying the worker." },
  FAILED: { label: "Failed", tone: "fail", blurb: "A test failed. The worker can fix it and resubmit." },
  PAID: { label: "Paid", tone: "paid", blurb: "Every test passed and PayPal paid the worker." },
  EXPIRED: { label: "Expired", tone: "returned", blurb: "The deadline passed. The hold was released." },
  DISPUTED: { label: "Disputed", tone: "disputed", blurb: "A party contested the result. A mediator proposes a split." },
  SETTLED: { label: "Settled", tone: "paid", blurb: "Settled by an agreed split." },
  ESCALATED: { label: "With a human", tone: "disputed", blurb: "The parties did not agree. A person decides." },
};

/** Where a contract's money is, in two or three words, from its state alone (lists have no ledger). */
export const MONEY_WORD: Record<ContractState, { label: string; tone: Tone }> = {
  DRAFT: { label: "not funded", tone: "neutral" },
  SIGNED: { label: "not funded", tone: "neutral" },
  FUNDED: { label: "held by PayPal", tone: "held" },
  SUBMITTED: { label: "held by PayPal", tone: "held" },
  VERIFYING: { label: "held by PayPal", tone: "held" },
  PASSED: { label: "paying out", tone: "paid" },
  FAILED: { label: "held by PayPal", tone: "held" },
  PAID: { label: "paid to worker", tone: "paid" },
  EXPIRED: { label: "hold released", tone: "returned" },
  DISPUTED: { label: "held by PayPal", tone: "held" },
  SETTLED: { label: "split paid out", tone: "paid" },
  ESCALATED: { label: "held by PayPal", tone: "held" },
};

export const CONTRACT_TYPE_META: Record<ContractType, { label: string; short: string }> = {
  website_milestone: { label: "Website milestone", short: "Website" },
  code_bounty: { label: "Code bounty", short: "Code bounty" },
};

export const LEDGER_KIND_META: Record<LedgerKind, { label: string; tone: Tone; flow: string }> = {
  AUTHORIZED: { label: "Hold placed", tone: "held", flow: "Payer → PayPal hold" },
  CAPTURED: { label: "Captured", tone: "held", flow: "Hold → Proviso" },
  PAID_OUT: { label: "Paid to worker", tone: "paid", flow: "Proviso → Worker" },
  VOIDED: { label: "Hold released", tone: "returned", flow: "Hold → Payer" },
  REFUNDED: { label: "Refunded", tone: "returned", flow: "Proviso → Payer" },
};

/** How each check kind works, in words a payer understands. */
export const CHECK_KIND_META: Record<CheckKind, { label: string; by: "code" | "browser" | "ai"; byLabel: string }> = {
  github_pr_merged: { label: "Pull request merged", by: "code", byLabel: "GitHub API" },
  github_checks_passed: { label: "CI checks passed", by: "code", byLabel: "GitHub API" },
  github_pr_references_issue: { label: "References the issue", by: "code", byLabel: "GitHub API" },
  http_ok: { label: "Page loads", by: "code", byLabel: "HTTP request" },
  dom_assert: { label: "Element present", by: "browser", byLabel: "Browser" },
  responsive: { label: "Works at phone width", by: "browser", byLabel: "Browser" },
  form_submits: { label: "Form submits", by: "browser", byLabel: "Browser" },
  ai_page_judgement: { label: "AI judgement", by: "ai", byLabel: "AI with screenshot" },
};

export function actorLabel(actor: unknown): { label: string; tone: Tone } {
  switch (actor as Actor | string) {
    case "payer":
      return { label: "Payer", tone: "payer" };
    case "worker":
      return { label: "Worker", tone: "worker" };
    case "verifier":
      return { label: "Verifier", tone: "machine" };
    case "mediator":
      return { label: "Mediator", tone: "machine" };
    case "paypal":
      return { label: "PayPal", tone: "neutral" };
    default:
      return { label: "Proviso", tone: "neutral" };
  }
}

/** "TERMS_EDITED" -> "Terms edited". */
export function humanize(code: string): string {
  const s = code.replace(/[_-]+/g, " ").toLowerCase().trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function dollarsToCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** ISO -> value for <input type="datetime-local"> in the browser's zone. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The deadline field's starting value for a drafted deadline. The drafter
 * gives a deadline stated as a day ("due in 3 days") as the end of that day
 * in UTC, which reads oddly far from UTC (05:29 the next morning at UTC+5:30);
 * the form starts it at the end of that same day where the payer is instead.
 */
export function draftedDeadlineToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const day = /^(\d{4}-\d{2}-\d{2})T23:59:59(?:\.000)?Z$/.exec(iso);
  return day ? `${day[1]}T23:59` : isoToLocalInput(iso);
}

export function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Deterministic (UTC) so server and client render the same text before hydration. */
export function formatUtc(iso: string, withTime = true): string {
  const d = new Date(iso);
  return (
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: d.getUTCFullYear() === new Date().getUTCFullYear() ? undefined : "numeric",
      hour: withTime ? "2-digit" : undefined,
      minute: withTime ? "2-digit" : undefined,
      hour12: false,
      timeZone: "UTC",
    }) + (withTime ? " UTC" : "")
  );
}

export function formatLocal(iso: string, withTime = true): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: withTime ? "numeric" : undefined,
    minute: withTime ? "2-digit" : undefined,
  });
}

/** "Nov 11 02:44:12" (24-hour, seconds) for the audit tape. */
export function formatTape(iso: string, zone: "local" | "utc"): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: zone === "utc" ? "UTC" : undefined });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: zone === "utc" ? "UTC" : undefined });
  return `${date} ${time}`;
}

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return diff >= 0 ? "in under a minute" : "just now";
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
