"use client";

/**
 * The contract's conditions as the verifier's run log: one row per test with
 * the verdict for the chosen attempt, the verifier's confidence and reasoning
 * in its own voice, and the evidence it collected. The first screenshot is
 * always in view: evidence that decided money is never behind a click.
 */
import { useMemo, type ReactNode } from "react";
import { CheckByBadge } from "../conditions-editor";
import { checkSignature, describeCheck } from "../checks";
import { CHECK_KIND_META, type Tone } from "../format";
import { IconCheck, IconCircle, IconExternal, IconQuestion, IconScan, IconX } from "../icons";
import { RelativeTime } from "../time";
import { cx, Tag } from "../ui";
import type { Submission } from "@/lib/types";
import type { SignedReceipt } from "@/lib/contract/service";
import { Evidence, evidenceScreenshots, ManipulationNotice, manipulationOf, Screenshot } from "./evidence";
import { CopyHash, evidenceHashes } from "./receipt-panel";
import { CheckedByCode, readPanel, ReviewPanel } from "./review-panel";
import type { ConditionRow, Outcome } from "./verdicts";

const OUTCOME_META: Record<Outcome, { label: string; tone: Tone; variant: "fill" | "outline"; row: string }> = {
  pass: { label: "Pass", tone: "paid", variant: "fill", row: "" },
  fail: { label: "Fail", tone: "fail", variant: "fill", row: "bg-fail-soft/70 shadow-[inset_3px_0_0_var(--fail)]" },
  inconclusive: {
    label: "Inconclusive",
    tone: "inconclusive",
    variant: "fill",
    row: "bg-inconclusive-soft/70 shadow-[inset_3px_0_0_var(--inconclusive)]",
  },
  checking: { label: "Checking", tone: "machine", variant: "outline", row: "scanbar bg-machine-soft/60 shadow-[inset_3px_0_0_var(--machine)]" },
  queued: { label: "Queued", tone: "neutral", variant: "outline", row: "" },
  not_run: { label: "Not run", tone: "neutral", variant: "outline", row: "" },
};

const GLYPH: Record<Outcome, ReactNode> = {
  pass: <IconCheck size={11} strokeWidth={3.2} />,
  fail: <IconX size={10} strokeWidth={3.2} />,
  inconclusive: <IconQuestion size={11} strokeWidth={2.8} />,
  checking: <IconScan size={11} strokeWidth={2.4} />,
  queued: <IconCircle size={11} strokeWidth={2.4} />,
  not_run: <IconCircle size={11} strokeWidth={2.4} />,
};

export function OutcomeChip({ outcome, stamp = false }: { outcome: Outcome; stamp?: boolean }) {
  const meta = OUTCOME_META[outcome];
  return (
    <Tag tone={meta.tone} variant={meta.variant} className={cx("gap-1 px-1.5", stamp && "stamp", outcome === "checking" && "pulse-dot")}>
      {GLYPH[outcome]}
      {meta.label}
    </Tag>
  );
}

/** Confidence as a figure and a ten-cell meter. */
function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const cells = Math.round(value * 10);
  return (
    <span className="inline-flex items-center gap-1.5" title={`Verifier confidence ${pct}%`}>
      <span className="text-ink-3">conf</span>
      <span className="text-ink">{pct}%</span>
      <span className="flex gap-px" aria-hidden>
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className={cx("h-2 w-[3px] rounded-[0.5px]", i < cells ? "bg-ink-2" : "bg-rule-strong")} />
        ))}
      </span>
    </span>
  );
}

export function Checklist({ rows, submission, receipt = null }: { rows: ConditionRow[]; submission: Submission | null; receipt?: SignedReceipt | null }) {
  const hashes = useMemo(() => evidenceHashes(receipt), [receipt]);
  return (
    <div>
      {submission ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-rule bg-surface-2 px-4 py-2 text-[0.78rem] text-ink-2">
          <span className="label">Checked against</span>
          <a
            href={submission.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-w-0 items-center gap-1 tnum text-[0.75rem] text-ink underline-offset-2 hover:underline"
          >
            <span className="truncate">{submission.url}</span>
            <IconExternal size={13} className="shrink-0" />
          </a>
          <span className="tnum text-[0.7rem] text-ink-3">
            · submitted <RelativeTime iso={submission.created_at} />
          </span>
        </div>
      ) : null}
      <ol className="divide-y divide-rule">
        {rows.map((row, i) => (
          // Keyed by outcome too, so a row animates in again the moment its verdict lands.
          <ChecklistRow
            key={`${row.condition.id}:${row.outcome}:${row.verdict?.id ?? ""}`}
            row={row}
            index={i}
            evidenceHash={row.verdict ? (hashes.get(row.verdict.id) ?? null) : null}
          />
        ))}
      </ol>
    </div>
  );
}

function ChecklistRow({ row, index, evidenceHash }: { row: ConditionRow; index: number; evidenceHash: string | null }) {
  const { condition, outcome } = row;
  // While a just-arrived verdict is played in (its reviewers voting), the row shows its evidence and panel but not its result yet.
  const voting = row.voting !== undefined;
  const verdict = voting ? null : row.verdict;
  const meta = OUTCOME_META[outcome];
  const shots = row.verdict ? evidenceScreenshots(row.verdict.evidence) : [];
  const manipulation = verdict ? manipulationOf(verdict.evidence) : null;
  const panel = row.verdict ? readPanel(row.verdict.evidence) : null;
  // A test decided by code is a fact: it gets a plain mark instead of a confidence meter.
  const byCode = verdict !== null && CHECK_KIND_META[condition.check_kind].by !== "ai";
  const openByDefault = outcome === "fail" || outcome === "inconclusive";
  const decided = outcome === "pass" || outcome === "fail" || outcome === "inconclusive";
  // A pass keeps its pass styling even when the page tried to steer the verifier: the alarm box inside is the red element.
  const rowTone = manipulation && outcome !== "pass" ? "bg-alarm-soft/60 shadow-[inset_3px_0_0_var(--alarm-fill)]" : meta.row;

  return (
    <li
      id={manipulation ? `manipulation-${condition.id}` : undefined}
      className={cx(
        "rise relative grid scroll-mt-24 grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-4 py-3.5 sm:grid-cols-[1.5rem_6.25rem_minmax(0,1fr)_auto]",
        rowTone,
      )}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <span className="col-start-1 row-start-1 pt-[3px] tnum text-[0.72rem] font-semibold text-ink-3">{String(index + 1).padStart(2, "0")}</span>
      <div className="col-start-2 row-start-1 pt-px">
        <OutcomeChip outcome={outcome} stamp={decided} />
      </div>

      <div className="col-start-2 row-start-2 min-w-0 sm:col-start-3 sm:row-start-1 [&_p]:max-w-[88ch]">
        <p className={cx("text-[0.9375rem] leading-snug font-semibold", outcome === "not_run" || outcome === "queued" ? "text-ink-2" : "text-ink")}>{condition.text}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[0.75rem] text-ink-3">{CHECK_KIND_META[condition.check_kind].label}</span>
          {byCode ? <CheckedByCode kind={condition.check_kind} /> : <CheckByBadge kind={condition.check_kind} />}
        </div>

        {verdict ? (
          <p className={cx("mt-2 flex gap-2 tnum text-[0.78rem] leading-[1.3rem]", outcome === "fail" || manipulation ? "text-ink" : "text-ink-2")}>
            <span className="shrink-0 text-machine select-none" aria-hidden>
              ·
            </span>
            <span className="min-w-0 break-words">
              <span className="sr-only">Verifier: </span>
              {verdict.reasoning}
            </span>
          </p>
        ) : (
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-3">{describeCheck(condition)}</p>
        )}

        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 tnum text-[0.66rem] text-ink-3">
          {verdict && !byCode && !panel && outcome !== "inconclusive" ? <Confidence value={verdict.confidence} /> : null}
          <span className="max-w-full truncate" title={checkSignature(condition)}>
            {checkSignature(condition)}
          </span>
          {verdict ? (
            <span>
              checked <RelativeTime iso={verdict.created_at} />
            </span>
          ) : null}
          {evidenceHash && !voting ? (
            <span className="inline-flex items-baseline gap-1" title="SHA-256 of this verdict's evidence, as the verifier signed it in the receipt">
              signed evidence <CopyHash value={evidenceHash} label="evidence hash" />
            </span>
          ) : null}
        </p>
      </div>

      {shots[0] ? (
        <div className="col-start-2 row-start-3 sm:col-start-4 sm:row-start-1">
          <Screenshot refPath={shots[0]} alt={`${condition.text}: screenshot 1 of ${shots.length}`} compact />
        </div>
      ) : null}

      {voting && panel ? (
        <div className="col-start-2 row-start-4 flex min-w-0 flex-col gap-2.5 sm:col-span-2 sm:col-start-3 sm:row-start-2">
          <ReviewPanel panel={panel} shown={row.voting} />
        </div>
      ) : null}

      {verdict ? (
        <div className="col-start-2 row-start-4 flex min-w-0 flex-col gap-2.5 sm:col-span-2 sm:col-start-3 sm:row-start-2">
          {manipulation ? <ManipulationNotice record={manipulation} outcome={outcome} /> : null}

          {panel ? <ReviewPanel panel={panel} defaultOpen={panel.decision !== "pass"} /> : null}

          <details className="group" open={openByDefault}>
            <summary className="inline-flex items-center gap-1.5 rounded-xs text-[0.75rem] font-semibold text-ink-2 hover:text-ink">
              <span className="chev inline-block text-ink-3 transition-transform" aria-hidden>
                ›
              </span>
              Evidence record
              {shots.length > 1 ? <span className="font-normal text-ink-3">· {shots.length} screenshots</span> : null}
            </summary>
            <div className="mt-2.5 flex flex-col gap-3 [&_p]:max-w-[88ch]">
              <Evidence evidence={verdict.evidence} label={condition.text} skipShots={1} />
              <p className="text-[0.72rem] text-ink-3">How it was checked: {describeCheck(condition)}</p>
            </div>
          </details>
        </div>
      ) : null}
    </li>
  );
}
