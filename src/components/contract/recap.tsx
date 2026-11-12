"use client";

/**
 * What just happened, in one line, once a contract is paid: the work went in,
 * every test passed (and how the AI reviewers voted), the verifier signed a
 * receipt, PayPal paid the worker, and how long all of that took. Every figure
 * is read from the contract's own records; nothing shows before it is PAID.
 */
import { useState } from "react";
import type { ContractBundle } from "../api";
import { formatCents } from "../format";
import { IconArrowRight } from "../icons";
import { cx } from "../ui";
import { readPanel } from "./review-panel";
import { latestVerdicts, verdictOutcome } from "./verdicts";

interface Recap {
  attempt: number;
  passed: number;
  total: number;
  /** Over the tests judged by an AI review panel: how many, and how their reviewers voted. */
  panel: { tests: number; reviewers: number; agreed: number } | null;
  signed: boolean;
  amountCents: number;
  /** Milliseconds from the passing submission to the contract becoming PAID. */
  tookMs: number;
}

export function readRecap(bundle: ContractBundle): Recap | null {
  const { contract } = bundle;
  if (contract.state !== "PAID" || bundle.dispute) return null;
  const paidAt = bundle.events
    .filter((e) => e.kind === "STATE_CHANGED" && e.detail.to === "PAID")
    .reduce<number | null>((t, e) => Math.max(t ?? 0, Date.parse(e.created_at)), null);
  const attempts = [...bundle.submissions].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const passedId = bundle.receipt?.receipt.outcome === "passed" ? bundle.receipt.receipt.submission_id : attempts.at(-1)?.id;
  const index = attempts.findIndex((s) => s.id === passedId);
  if (paidAt === null || index < 0) return null;

  const verdicts = [...latestVerdicts(bundle.verdicts, attempts[index].id).values()];
  const panels = verdicts.flatMap((v) => readPanel(v.evidence) ?? []);
  return {
    attempt: index + 1,
    passed: verdicts.filter((v) => verdictOutcome(v) === "pass").length,
    total: bundle.conditions.length,
    panel: panels.length
      ? {
          tests: panels.length,
          reviewers: panels.reduce((n, p) => n + p.reviewers.length, 0),
          agreed: panels.reduce((n, p) => n + p.reviewers.filter((r) => r.vote === "pass").length, 0),
        }
      : null,
    signed: bundle.receipt?.receipt.submission_id === attempts[index].id,
    amountCents: bundle.payout?.amount_cents ?? contract.amount_cents,
    tookMs: Math.max(0, paidAt - Date.parse(attempts[index].created_at)),
  };
}

/** "45 s", "6 min 45 s", "2 h 5 min", "3 d 4 h". */
export function formatTook(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

function panelWords(p: NonNullable<Recap["panel"]>): string {
  if (p.tests > 1) return `${p.tests} judged by AI review panels`;
  return p.agreed === p.reviewers ? `all ${p.reviewers} AI reviewers agreed` : `${p.agreed} of ${p.reviewers} AI reviewers agreed`;
}

export function Recap({ bundle, worker }: { bundle: ContractBundle; worker: string }) {
  const recap = readRecap(bundle);
  // Shown with a short stamp when it appears while the page is open (the payout just landed), not on a reload.
  const [atOpen] = useState(recap !== null);
  if (!recap) return null;
  const step = <IconArrowRight size={12} className="shrink-0 text-ink-3" aria-hidden />;

  return (
    <dl className={cx("flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[0.8125rem]", !atOpen && "stamp")}>
      <dt className="label">Recap</dt>
      <dd className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink">
        <span>Work submitted{recap.attempt > 1 ? ` (attempt ${recap.attempt})` : ""}</span>
        {step}
        <span>
          <span className="tnum">
            {recap.passed} of {recap.total}
          </span>{" "}
          tests passed{recap.panel ? <span className="text-ink-2">, {panelWords(recap.panel)}</span> : null}
        </span>
        {recap.signed ? (
          <>
            {step}
            <span>Receipt signed</span>
          </>
        ) : null}
        {step}
        <span className="text-paid">
          PayPal paid {worker} <span className="tnum font-semibold">{formatCents(recap.amountCents, bundle.contract.currency)}</span>
        </span>
        <span className="text-ink-3" aria-hidden>
          ·
        </span>
        <span className="text-ink-2">
          <span className="tnum font-semibold text-ink">{formatTook(recap.tookMs)}</span> from submission to payment
        </span>
      </dd>
    </dl>
  );
}
