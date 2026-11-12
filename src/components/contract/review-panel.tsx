"use client";

/**
 * How a test was decided. An AI-judged test is decided by a panel of
 * reviewers, not by one model (src/lib/verifier/ai-judgement.ts): each
 * reviewer judges the same page from its own angle, and the test passes or
 * fails only if every reviewer agrees. This draws the panel as it was recorded
 * in `evidence.panel`: each reviewer by role, its vote as a shape and a word,
 * its confidence and, on request, its reasoning; the rule; and the result. A
 * split reads as what it is: the reviewers disagreed, so a person decides.
 *
 * A test decided by code (HTTP, browser, GitHub) gets a plain mark instead, so
 * a fact and a judgement never look alike.
 */
import { useId, useState, type ReactNode } from "react";
import type { CheckKind, VerdictEvidence } from "@/lib/types";
import { CHECK_KIND_META, humanize, type Tone } from "../format";
import { IconCode, IconCheck, IconQuestion, IconShield, IconX } from "../icons";
import { cx, Tag, TONE_TEXT } from "../ui";

export type PanelVote = "pass" | "fail" | "unsure" | "error";

export interface PanelReviewer {
  reviewer: string;
  vote: PanelVote;
  confidence: number | null;
  reasoning: string;
  manipulationReported: boolean;
}

export interface Panel {
  /** The rule as the verifier wrote it. */
  rule: string | null;
  /** The confidence every reviewer must reach, read from the rule; null if it does not say. */
  threshold: number | null;
  decision: "pass" | "fail" | "inconclusive";
  reviewers: PanelReviewer[];
}

const VOTES: ReadonlySet<string> = new Set(["pass", "fail", "unsure", "error"]);

/**
 * The panel recorded on a verdict's evidence, or null when the test was not
 * judged by a panel (a code check, a single judge, an older verdict). Every
 * field is read defensively: evidence is stored JSON.
 */
export function readPanel(evidence: VerdictEvidence): Panel | null {
  const raw = (evidence as Record<string, unknown>).panel;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const reviewers = (Array.isArray(p.votes) ? p.votes : []).flatMap((v): PanelReviewer[] => {
    if (!v || typeof v !== "object") return [];
    const o = v as Record<string, unknown>;
    const error = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>).message : undefined;
    const confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.min(1, Math.max(0, o.confidence)) : null;
    return [
      {
        reviewer: typeof o.reviewer === "string" && o.reviewer ? o.reviewer : "reviewer",
        vote: typeof o.vote === "string" && VOTES.has(o.vote) ? (o.vote as PanelVote) : "error",
        confidence,
        reasoning: typeof o.reasoning === "string" && o.reasoning ? o.reasoning : typeof error === "string" ? error : "",
        manipulationReported: o.manipulation_reported === true,
      },
    ];
  });
  if (reviewers.length === 0) return null;
  const rule = typeof p.rule === "string" && p.rule ? p.rule : null;
  const threshold = rule ? /(\d*\.?\d+)\s*confidence/.exec(rule) : null;
  const decision =
    p.decision === "pass" || p.decision === "fail" || p.decision === "inconclusive"
      ? p.decision
      : reviewers.every((r) => r.vote === "pass")
        ? "pass"
        : reviewers.every((r) => r.vote === "fail")
          ? "fail"
          : "inconclusive";
  return { rule, threshold: threshold ? Number(threshold[1]) : null, decision, reviewers };
}

/** The reviewers' roles, as ai-judgement.ts frames them. */
const ROLES: Record<string, { name: string; brief: string }> = {
  literal: { name: "Strict reader", brief: "Takes the test word by word" },
  worker_side: { name: "Worker's advocate", brief: "Looks for every way the work meets it" },
  skeptic: { name: "Sceptic", brief: "Hunts for manipulation and missing evidence" },
  judge: { name: "Single judge", brief: "One AI reviewer" },
};

export function reviewerName(id: string): string {
  return ROLES[id]?.name ?? humanize(id);
}

const VOTE_META: Record<PanelVote, { word: string; tone: Tone; variant: "fill" | "outline"; glyph: ReactNode; edge: string }> = {
  pass: { word: "Pass", tone: "paid", variant: "fill", glyph: <IconCheck size={11} strokeWidth={3.2} />, edge: "shadow-[inset_0_2px_0_var(--paid)]" },
  fail: { word: "Fail", tone: "fail", variant: "fill", glyph: <IconX size={10} strokeWidth={3.2} />, edge: "shadow-[inset_0_2px_0_var(--fail)]" },
  unsure: {
    word: "Unsure",
    tone: "inconclusive",
    variant: "outline",
    glyph: <IconQuestion size={11} strokeWidth={2.8} />,
    edge: "shadow-[inset_0_2px_0_var(--inconclusive)]",
  },
  error: {
    word: "No answer",
    tone: "neutral",
    variant: "outline",
    glyph: (
      <span className="leading-none" aria-hidden>
        –
      </span>
    ),
    edge: "shadow-[inset_0_2px_0_var(--rule-strong)]",
  },
};

export function VoteTag({ vote, className }: { vote: PanelVote; className?: string }) {
  const meta = VOTE_META[vote];
  return (
    <Tag tone={meta.tone} variant={meta.variant} className={cx("gap-1 px-1.5", className)}>
      {meta.glyph}
      {meta.word}
    </Tag>
  );
}

function count(panel: Panel, vote: PanelVote): number {
  return panel.reviewers.filter((r) => r.vote === vote).length;
}

/** "2 pass · 1 fail": the votes as a tally, in a fixed order. */
function tally(panel: Panel): string {
  return (["pass", "fail", "unsure", "error"] as const)
    .map((v) => [v, count(panel, v)] as const)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${v === "error" ? "no answer" : v}`)
    .join(" · ");
}

/** The panel's result in words: unanimous, or why a person decides. */
function result(panel: Panel): { tone: Tone; glyph: ReactNode; text: string } {
  const n = panel.reviewers.length;
  if (panel.decision === "pass") return { tone: "paid", glyph: <IconCheck size={14} strokeWidth={3} />, text: `All ${n} agree: pass` };
  if (panel.decision === "fail") return { tone: "fail", glyph: <IconX size={13} strokeWidth={3} />, text: `All ${n} agree: fail` };
  const glyph = <IconQuestion size={14} strokeWidth={2.8} />;
  if (count(panel, "pass") > 0 && count(panel, "fail") > 0) return { tone: "inconclusive", glyph, text: "Reviewers disagreed, so a person decides" };
  if (count(panel, "unsure") > 0) {
    const unsure = count(panel, "unsure");
    return { tone: "inconclusive", glyph, text: `${unsure === 1 ? "A reviewer was" : `${unsure} reviewers were`} unsure, so a person decides` };
  }
  if (count(panel, "error") > 0) return { tone: "inconclusive", glyph, text: "A reviewer could not answer, so a person decides" };
  return { tone: "inconclusive", glyph, text: "No agreement, so a person decides" };
}

function ruleText(panel: Panel): string {
  const n = panel.reviewers.length;
  const each = panel.threshold !== null ? `, each at least ${Math.round(panel.threshold * 100)}% sure` : "";
  const all = n === 3 ? "all three" : `all ${n}`;
  return `Rule: a pass or a fail needs ${all} to agree${each}. Anything else is not decided by the AI.`;
}

/** Confidence as a figure and a ten-cell meter, as in the run log. */
function ReviewerConfidence({ value }: { value: number | null }) {
  if (value === null) return <span className="tnum text-[0.72rem] text-ink-3">no reply</span>;
  const pct = Math.round(value * 100);
  const cells = Math.round(value * 10);
  return (
    <span className="inline-flex items-center gap-1.5 tnum text-[0.72rem]">
      <span className="text-ink-3">conf</span>
      <span className="font-semibold text-ink">{pct}%</span>
      <span className="flex gap-px" aria-hidden>
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className={cx("h-2 w-[3px] rounded-[0.5px]", i < cells ? "bg-ink-2" : "bg-rule-strong")} />
        ))}
      </span>
    </span>
  );
}

/**
 * The review panel of one AI-judged test. `defaultOpen` shows every reviewer's reasoning at once. `shown`, while a
 * verdict that just arrived is played in (staged-rows.ts), is how many votes to show so far: the rest read as still
 * voting and the result waits until all are in.
 */
export function ReviewPanel({ panel, defaultOpen = false, shown, className }: { panel: Panel; defaultOpen?: boolean; shown?: number; className?: string }) {
  const [opened, setOpen] = useState(defaultOpen);
  const voting = shown !== undefined;
  const open = opened && !voting;
  const id = useId();
  const outcome = result(panel);
  const n = panel.reviewers.length;
  // A panel larger than three repeats the roles; number the repeats so each reviewer has its own name.
  const seen = new Map<string, number>();
  const names = panel.reviewers.map((r) => {
    const k = (seen.get(r.reviewer) ?? 0) + 1;
    seen.set(r.reviewer, k);
    return k > 1 ? `${reviewerName(r.reviewer)} ${k}` : reviewerName(r.reviewer);
  });

  return (
    <div role="group" aria-label={`Review panel: ${n} AI reviewers`} className={cx("@container border border-rule bg-surface", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-rule bg-surface-2 px-2.5 py-1.5">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[0.75rem]">
          <span className="font-semibold text-machine">Review panel</span>
          <span className="text-ink-2">{n} AI reviewers judged it independently</span>
        </p>
        {voting ? (
          <p className="flex items-center gap-1.5 tnum text-[0.8125rem] leading-5 font-semibold text-machine">
            <span className="pulse-dot size-1.5 rounded-[1px] bg-machine-fill" aria-hidden />
            Reviewers voting · {shown} of {n}
          </p>
        ) : (
          <p className={cx("stamp flex items-center gap-1.5 text-[0.8125rem] leading-5 font-semibold", TONE_TEXT[outcome.tone])} aria-live="polite">
            {outcome.glyph}
            {outcome.text}
            {panel.decision === "inconclusive" ? <span className="tnum text-[0.75rem] font-normal text-ink-2">· {tally(panel)}</span> : null}
          </p>
        )}
      </div>
      <ul
        id={`${id}-votes`}
        className={cx("grid grid-cols-1 gap-px bg-rule", n === 2 ? "@min-[26rem]:grid-cols-2" : "@min-[26rem]:grid-cols-3")}
      >
        {panel.reviewers.map((r, i) => {
          const meta = VOTE_META[r.vote];
          const role = ROLES[r.reviewer];
          const waiting = voting && i >= shown;
          return (
            <li key={i} className={cx("flex min-w-0 flex-col bg-surface px-2.5 pt-2 pb-2", waiting ? "shadow-[inset_0_2px_0_var(--rule-strong)]" : meta.edge)}>
              <p className="text-[0.8125rem] leading-[1.15rem] font-semibold text-ink">
                {names[i]}
                <span className="sr-only">
                  : {meta.word}
                  {r.confidence !== null ? `, confidence ${Math.round(r.confidence * 100)}%` : ""}
                </span>
              </p>
              {role ? <p className="text-[0.68rem] leading-4 text-ink-3">{role.brief}</p> : null}
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1" aria-hidden>
                {waiting ? (
                  <Tag tone="neutral" variant="outline" className="pulse-dot gap-1 px-1.5">
                    <span className="size-1.5 rounded-[1px] bg-current" /> Voting
                  </Tag>
                ) : (
                  <>
                    <VoteTag vote={r.vote} className={voting ? "stamp" : undefined} />
                    <ReviewerConfidence value={r.confidence} />
                  </>
                )}
              </p>
              {r.manipulationReported && !waiting ? (
                <p className="mt-1.5 flex items-center gap-1 text-[0.68rem] leading-4 font-semibold text-alarm">
                  <IconShield size={12} strokeWidth={2.4} className="shrink-0" /> Flagged text aimed at the verifier
                </p>
              ) : null}
              {open && r.reasoning ? (
                <p className="mt-2 border-t border-rule pt-1.5 text-[0.75rem] leading-[1.15rem] break-words text-ink-2">{r.reasoning}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-rule px-2.5 py-1.5">
        <p className="min-w-0 text-[0.7rem] leading-4 text-ink-3" title={panel.rule ?? undefined}>
          {ruleText(panel)}
        </p>
        <button
          type="button"
          hidden={voting}
          aria-expanded={open}
          aria-controls={`${id}-votes`}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xs text-[0.72rem] font-semibold text-ink-2 hover:text-ink"
        >
          <span className={cx("inline-block text-ink-3 transition-transform duration-100", open && "rotate-90")} aria-hidden>
            ›
          </span>
          {open ? "Hide the reasoning" : "Each reviewer's reasoning"}
        </button>
      </div>
    </div>
  );
}

/** The mark of a test decided by code: a fact, with no reviewers and no confidence to weigh. */
export function CheckedByCode({ kind }: { kind: CheckKind }) {
  const meta = CHECK_KIND_META[kind];
  return (
    <span className="inline-flex items-center gap-1.5" title="Decided by code: the same input always gives the same answer. No AI is involved.">
      <span className="inline-flex h-[1.125rem] items-center gap-1 rounded-xs px-1.5 text-[0.66rem] font-semibold text-ink-2 uppercase ring-1 ring-field ring-inset">
        <IconCode size={11} strokeWidth={2.2} />
        Checked by code
      </span>
      <span className="text-[0.72rem] text-ink-3">{meta.byLabel} · a fact, not a judgement</span>
    </span>
  );
}
