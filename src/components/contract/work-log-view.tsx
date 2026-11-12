"use client";

/**
 * The verifier's work log in the run log (docs/design.md, "Work log" and "Run
 * telemetry"): every step the verifier took while checking a test, live while
 * the run is running and as an inspectable record afterwards, plus the run's
 * figures in the run log header. What a row may show comes from work-log.ts;
 * step facts are data from the run and are rendered as text only.
 */
import { useEffect, useMemo, useState } from "react";
import type { TraceStep, TraceStepKind } from "@/lib/contract/service";
import { humanize } from "../format";
import { IconQuestion, IconX } from "../icons";
import { useHydrated } from "../time";
import { cx, Tag } from "../ui";
import { useReducedMotion } from "../use-reduced-motion";
import { copyText } from "./receipt-panel";
import {
  factLabel,
  factText,
  formatDuration,
  formatStepTime,
  KIND_META,
  logSummary,
  runMetrics,
  stepBar,
  stepElapsed,
  stepState,
  stepWindow,
  type LogPhase,
  type RunMetrics,
  type StepState,
} from "./work-log";

/** What every work log on the page reads: the server's clock now, whether the run is live, and the kind filter. */
export interface WorkLogEnv {
  serverNow: number | null;
  live: boolean;
  filter: TraceStepKind | null;
}

/**
 * The server's clock, ticking ten times a second while the run is live (once a
 * second under reduced motion). The offset is taken when each bundle arrives
 * (`trace.now` minus the client's clock), so running steps are timed against the
 * server, not the viewer's machine.
 */
export function useServerNow(traceNow: string | null, live: boolean): number | null {
  const reduced = useReducedMotion();
  const [tick, setTick] = useState<{ base: string; now: number } | null>(null);
  useEffect(() => {
    if (!traceNow) return;
    const server = Date.parse(traceNow);
    if (!Number.isFinite(server)) return;
    const offset = server - Date.now();
    const update = () => setTick({ base: traceNow, now: Date.now() + offset });
    const first = setTimeout(update, 0);
    const timer = live ? setInterval(update, reduced ? 1000 : 100) : undefined;
    return () => {
      clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }, [traceNow, live, reduced]);
  if (!traceNow) return null;
  if (tick && tick.base === traceNow) return tick.now;
  const server = Date.parse(traceNow);
  return Number.isFinite(server) ? server : null;
}

const STATE_WORD: Record<StepState, string> = {
  running: "running",
  done: "done",
  failed: "failed",
  cut_off: "cut off when its check ended",
};

const BAR: Record<StepState, string> = {
  running: "bg-machine-fill step-running",
  done: "bg-ink-3",
  failed: "bg-fail-fill",
  cut_off: "bg-inconclusive-fill",
};

function DurationCell({ step, env, state }: { step: TraceStep; env: WorkLogEnv; state: StepState }) {
  const ms = stepElapsed(step, env.serverNow, env.live);
  if (state === "cut_off" || ms === null) {
    return (
      <span className="inline-flex items-center justify-end gap-0.5 text-inconclusive" title="Cut off when its check ended">
        <IconQuestion size={10} strokeWidth={2.8} />
        <span>{ms === null ? "no end" : formatDuration(ms)}</span>
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="inline-flex items-center justify-end gap-0.5 text-fail">
        <IconX size={9} strokeWidth={3.2} />
        <span>{formatDuration(ms)}</span>
      </span>
    );
  }
  return <span className={state === "running" ? "text-machine" : "text-ink-2"}>{formatDuration(ms, state === "running")}</span>;
}

/** Up to four facts on the step's line, `key value`, as text. */
function inlineFacts(step: TraceStep): string {
  return [...Object.entries(step.detail), ...Object.entries(step.result)]
    .slice(0, 4)
    .map(([k, v]) => `${factLabel(k)} ${factText(v)}`)
    .join(" · ");
}

function StepRecord({ step, total, env, state, phase }: { step: TraceStep; total: number; env: WorkLogEnv; state: StepState; phase: LogPhase }) {
  const hydrated = useHydrated();
  const ms = stepElapsed(step, env.serverNow, env.live);
  const detail = Object.entries(step.detail);
  const result = Object.entries(step.result);
  return (
    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-t border-rule bg-inset px-2.5 py-2 text-[0.7rem] leading-[1.05rem]">
      <dt className="text-ink-3">Step</dt>
      <dd className="tnum text-ink">
        {step.seq} <span className="text-ink-3">of this run · {total} shown here</span>
      </dd>
      <dt className="text-ink-3">Kind</dt>
      <dd className="text-ink">{KIND_META[step.kind].one}</dd>
      <dt className="text-ink-3">Status</dt>
      <dd className={cx(state === "failed" ? "text-fail" : state === "cut_off" ? "text-inconclusive" : state === "running" ? "text-machine" : "text-ink")}>
        {STATE_WORD[state]}
      </dd>
      <dt className="text-ink-3">Started</dt>
      <dd className="tnum text-ink">
        <time dateTime={step.started_at} title={step.started_at}>
          {formatStepTime(step.started_at, hydrated ? "local" : "utc")}
        </time>
      </dd>
      <dt className="text-ink-3">Duration</dt>
      <dd className="tnum text-ink">
        {step.duration_ms !== null ? `${step.duration_ms} ms` : ms !== null ? `${formatDuration(ms, true)} so far` : "no end recorded"}
      </dd>
      {detail.map(([k, v]) => (
        <Fact key={`d:${k}`} k={k} v={factText(v)} />
      ))}
      {result.length > 0 ? (
        <>
          <dt className="col-span-2 mt-1 border-t border-rule pt-1 label text-[0.68rem]">Result</dt>
          {result.map(([k, v]) => (
            <Fact key={`r:${k}`} k={k} v={factText(v)} />
          ))}
        </>
      ) : null}
      {phase === "running" ? <dd className="col-span-2 mt-1 text-ink-3">What this step found shows once the test has its verdict.</dd> : null}
    </dl>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="truncate text-ink-3" title={k}>
        {humanize(k)}
      </dt>
      <dd className="font-code text-[0.68rem] break-all text-ink">{v}</dd>
    </>
  );
}

/** One line per step in start order, with a waterfall over the steps' own window. */
export function StepList({ steps, env, phase }: { steps: TraceStep[]; env: WorkLogEnv; phase: LogPhase }) {
  const [open, setOpen] = useState<string | null>(null);
  const frame = stepWindow(steps, env.serverNow, env.live);
  return (
    <ol className="divide-y divide-rule border border-rule bg-surface" aria-label="Steps the verifier took">
      {steps.map((s) => {
        const state = stepState(s, env.live);
        const bar = frame ? stepBar(s, frame, env.serverNow, env.live) : { offset: 0, width: 0 };
        const expanded = open === s.id;
        const facts = inlineFacts(s);
        const dim = env.filter !== null && env.filter !== s.kind;
        const lit = env.filter !== null && env.filter === s.kind;
        return (
          <li
            key={s.id}
            className={cx(
              "rise",
              lit && "bg-accent-soft shadow-[inset_2px_0_0_var(--accent-fill)]",
              !lit && state === "failed" && "shadow-[inset_2px_0_0_var(--fail)]",
              !lit && state === "cut_off" && "shadow-[inset_2px_0_0_var(--inconclusive)]",
            )}
          >
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : s.id)}
              // On a phone the waterfall runs under the label, so the label keeps the width; from sm it is a column.
              // Dimming sits on the button: the line's rise animation holds the li's own opacity at 1.
              className={cx(
                "grid min-h-[30px] w-full grid-cols-[3.6rem_minmax(0,1fr)_3.5rem] items-center gap-x-2 gap-y-1 px-2 py-1 text-left transition-[background-color,opacity] duration-150 hover:bg-surface-2 sm:grid-cols-[1.25rem_3.75rem_minmax(0,1.25fr)_minmax(5rem,1fr)_3.75rem] sm:gap-y-0",
                dim ? "opacity-40" : "opacity-100",
              )}
            >
              <span className="tnum text-[0.66rem] text-ink-3 max-sm:hidden">{s.seq}</span>
              <Tag tone={state === "running" ? "machine" : "neutral"} variant="outline" className="col-start-1 row-start-1 w-full px-1 text-[0.6rem] sm:col-start-2">
                {KIND_META[s.kind].mark}
              </Tag>
              <span className="col-start-2 row-start-1 min-w-0 sm:col-start-3">
                <span className="block truncate text-[0.75rem] leading-[1.05rem] text-ink" title={s.label}>
                  {s.label}
                </span>
                {facts ? (
                  <span className="block truncate font-code text-[0.62rem] leading-[0.95rem] text-ink-3" title={facts}>
                    {facts}
                  </span>
                ) : null}
              </span>
              <span
                className="relative col-span-2 col-start-2 row-start-2 h-1.5 overflow-hidden rounded-[1px] bg-surface-2 ring-1 ring-inset ring-rule sm:col-span-1 sm:col-start-4 sm:row-start-1"
                aria-hidden
              >
                <span
                  className={cx("step-bar absolute inset-y-0 rounded-[1px]", BAR[state])}
                  style={{ left: `${bar.offset * 100}%`, width: `max(2px, ${bar.width * 100}%)` }}
                />
              </span>
              <span className="col-start-3 row-start-1 text-right tnum text-[0.7rem] whitespace-nowrap sm:col-start-5">
                <DurationCell step={s} env={env} state={state} />
              </span>
            </button>
            {expanded ? <StepRecord step={s} total={steps.length} env={env} state={state} phase={phase} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One test's work log. While the test is being checked it is open and live;
 * once the row shows its outcome it folds away under a summary, like the
 * evidence record, and opens while a kind filter is on.
 */
export function CheckWorkLog({ steps, phase, env }: { steps: TraceStep[]; phase: LogPhase; env: WorkLogEnv }) {
  const [userOpen, setUserOpen] = useState(false);
  const metrics = useMemo(() => runMetrics(steps, env.serverNow, env.live), [steps, env.serverNow, env.live]);
  if (phase === "hidden" || steps.length === 0) return null;
  // A kind filter opens the logs that have that kind of step, so the lit steps are in view.
  const lit = env.filter !== null && steps.some((s) => s.kind === env.filter);
  if (phase === "running") {
    return (
      <section aria-label="Work log, live" className="flex min-w-0 flex-col gap-1.5">
        <p className="flex flex-wrap items-baseline gap-x-2 text-[0.75rem] font-semibold text-machine">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-1.5 rounded-[1px] bg-machine-fill pulse-dot" aria-hidden />
            Verifier · work log
          </span>
          <span className="tnum font-normal text-ink-3">
            {metrics.total} step{metrics.total === 1 ? "" : "s"}
            {metrics.running > 0 ? ` · ${metrics.running} running` : ""}
          </span>
        </p>
        <StepList steps={steps} env={env} phase={phase} />
      </section>
    );
  }
  return (
    <details
      className="group"
      open={userOpen || lit}
      onToggle={(e) => {
        if (!lit) setUserOpen(e.currentTarget.open);
      }}
    >
      <summary className="inline-flex items-center gap-1.5 rounded-xs text-[0.75rem] font-semibold text-ink-2 hover:text-ink">
        <span className="chev inline-block text-ink-3 transition-transform" aria-hidden>
          ›
        </span>
        Work log
        <span className={cx("tnum font-normal", metrics.failed > 0 ? "text-ink-2" : "text-ink-3")}>· {logSummary(metrics)}</span>
      </summary>
      <div className="mt-2">
        <StepList steps={steps} env={env} phase={phase} />
      </div>
    </details>
  );
}

/** The run's own steps (signing the receipt), once, at the foot of the run log. */
export function RunRecord({ steps, env, phase }: { steps: TraceStep[]; env: WorkLogEnv; phase: LogPhase }) {
  if (steps.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-rule bg-surface-2 px-4 py-2.5">
      <p className="label">Run record · what the verifier did after the last test</p>
      <StepList steps={steps} env={env} phase={phase} />
    </div>
  );
}

/** How much of the run's step time each kind took, as one thin bar; the figures beside it are the legend. */
function TimeBar({ metrics, filter }: { metrics: RunMetrics; filter: TraceStepKind | null }) {
  const total = metrics.byKind.reduce((n, k) => n + k.ms, 0);
  if (total <= 0) return null;
  return (
    <div className="flex min-w-[12rem] grow basis-64 items-center gap-2">
      <span className="label shrink-0">Step time by kind</span>
      <span className="flex h-1.5 min-w-0 grow gap-px" aria-hidden>
        {metrics.byKind.map((k, i) => (
          <span
            key={k.kind}
            title={`${KIND_META[k.kind].label}: ${formatDuration(k.ms)}`}
            className={cx(
              "h-full min-w-[2px] rounded-[1px] bg-machine-fill transition-opacity duration-150",
              filter === null ? (i % 2 === 0 ? "opacity-100" : "opacity-55") : filter === k.kind ? "opacity-100" : "opacity-20",
            )}
            style={{ flexGrow: k.ms, flexBasis: 0 }}
          />
        ))}
      </span>
      <span className="sr-only">
        {metrics.byKind.map((k) => `${KIND_META[k.kind].label} ${formatDuration(k.ms)}`).join(", ")}
      </span>
    </div>
  );
}

function CopyLog({ payload }: { payload: () => string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <button
        type="button"
        onClick={async () => setState((await copyText(payload())) ? "copied" : "failed")}
        className="inline-flex h-7 items-center rounded-xs px-2 text-[0.72rem] font-semibold text-ink-2 ring-1 ring-inset ring-field transition-colors duration-100 hover:bg-surface-2 hover:text-ink"
      >
        Copy work log (JSON)
      </button>
      <span role="status" className="text-[0.66rem] text-ink-3">
        {state === "copied" ? "copied" : state === "failed" ? "copy failed" : ""}
      </span>
    </span>
  );
}

/**
 * The selected attempt's figures under the run log headline: time so far, steps,
 * one toggle per kind that occurred (pressing one lights that kind's steps in
 * every work log and dims the rest), and where the time went.
 */
export function RunTelemetry({
  steps,
  env,
  onFilter,
  submissionId,
  redacted,
}: {
  steps: TraceStep[];
  env: WorkLogEnv;
  onFilter: (kind: TraceStepKind | null) => void;
  submissionId: string;
  /** Some checks are still running, so their results are left out of what is shown and copied. */
  redacted: boolean;
}) {
  const metrics = useMemo(() => runMetrics(steps, env.serverNow, env.live), [steps, env.serverNow, env.live]);
  if (steps.length === 0) return null;
  const payload = () =>
    JSON.stringify(
      {
        submission_id: submissionId,
        ...(redacted ? { note: "The run is in progress: results of checks without a verdict yet are left out." } : {}),
        steps,
      },
      null,
      2,
    );
  return (
    <div className="flex flex-col gap-1.5 border-t border-rule px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="flex items-baseline gap-x-3 tnum text-[0.8125rem]">
          <span className="inline-flex items-baseline gap-1.5">
            <span className="label text-machine">Verifier</span>
            <span className={cx("min-w-[3.25rem] font-semibold", metrics.running > 0 ? "text-machine" : "text-ink")}>
              {metrics.elapsedMs === null ? "–" : formatDuration(metrics.elapsedMs, metrics.running > 0)}
            </span>
          </span>
          <span className="inline-flex items-baseline gap-1">
            <span className="font-semibold text-ink">{metrics.total}</span>
            <span className="label">steps</span>
          </span>
          {metrics.running > 0 ? (
            <span className="inline-flex items-baseline gap-1">
              <span className="font-semibold text-machine">{metrics.running}</span>
              <span className="label">running</span>
            </span>
          ) : null}
          {metrics.failed > 0 ? (
            <span className="inline-flex items-baseline gap-1 text-fail">
              <IconX size={9} strokeWidth={3.2} className="self-center" />
              <span className="font-semibold">{metrics.failed}</span>
              <span className="label text-fail">failed</span>
            </span>
          ) : null}
        </p>
        <div role="group" aria-label="Highlight one kind of step" className="flex flex-wrap gap-1">
          {metrics.byKind.map((k) => {
            const on = env.filter === k.kind;
            return (
              <button
                key={k.kind}
                type="button"
                aria-pressed={on}
                onClick={() => onFilter(on ? null : k.kind)}
                title={`${k.count} ${k.count === 1 ? KIND_META[k.kind].one : KIND_META[k.kind].label.toLowerCase()} · ${formatDuration(k.ms)} of step time`}
                className={cx(
                  "inline-flex h-7 items-baseline gap-1 rounded-xs px-2 pt-[5px] tnum text-[0.72rem] ring-1 ring-inset transition-colors duration-100",
                  on ? "bg-accent-soft text-ink ring-accent-fill" : "text-ink-2 ring-rule-strong hover:bg-surface-2 hover:text-ink",
                )}
              >
                <span className="font-semibold text-ink">{k.count}</span>
                <span>{KIND_META[k.kind].label}</span>
                <span className="text-ink-3">{formatDuration(k.ms)}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <TimeBar metrics={metrics} filter={env.filter} />
        <CopyLog payload={payload} />
      </div>
    </div>
  );
}
