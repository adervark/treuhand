/**
 * The verifier's work log as the run log shows it (docs/design.md, "Work log"):
 * pure derivations over the steps `GET /api/contracts/[id]` serves as `trace`
 * (src/lib/verifier/trace-types.ts). Which steps a row may show, each check's
 * waterfall, the run's figures by kind, the server clock and how a duration
 * reads. No React here, so all of it is unit-tested.
 */
import type { TraceFacts, TraceStep, TraceStepKind } from "@/lib/contract/service";
import type { Outcome } from "./verdicts";

/** Each kind in the order the run's figures list it, with the words the page uses. Exhaustive by type. */
export const KIND_META: Record<TraceStepKind, { mark: string; label: string; one: string }> = {
  guard: { mark: "Guard", label: "Guard checks", one: "guard check" },
  network: { mark: "Net", label: "Network requests", one: "network request" },
  browser: { mark: "Browser", label: "Browser actions", one: "browser action" },
  measure: { mark: "Measure", label: "Measurements", one: "measurement" },
  screenshot: { mark: "Shot", label: "Screenshots", one: "screenshot" },
  model: { mark: "AI", label: "AI reviewer calls", one: "AI reviewer call" },
  decision: { mark: "Decide", label: "Decisions", one: "decision" },
  record: { mark: "Record", label: "Records", one: "record" },
};
export const KIND_ORDER = Object.keys(KIND_META) as TraceStepKind[];

/** A step that is still running this long after it started is not trusted to be running: its time is not shown. */
export const MAX_ELAPSED_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// What a row may show
// ---------------------------------------------------------------------------

/**
 * How much of a check's work log its row may show. `hidden`: nothing (the row
 * is queued). `running`: steps without their results and without decisions,
 * because the row's outcome is not on screen yet. `decided`: everything.
 */
export type LogPhase = "hidden" | "running" | "decided";

export function logPhase(row: { outcome: Outcome; voting?: number }): LogPhase {
  if (row.outcome === "queued") return "hidden";
  if (row.outcome === "checking" || row.voting !== undefined) return "running";
  return "decided";
}

/** The steps a row in `phase` may show. Nothing announces a result before the run log does. */
export function redactSteps(steps: TraceStep[], phase: LogPhase): TraceStep[] {
  if (phase === "hidden") return [];
  if (phase === "decided") return steps;
  return steps.filter((s) => s.kind !== "decision").map((s) => (Object.keys(s.result).length === 0 ? s : { ...s, result: {} }));
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface SubmissionSteps {
  /** condition id -> that check's steps, in start order. */
  byCondition: Map<string, TraceStep[]>;
  /** Run-level steps (no condition): signing the receipt. */
  run: TraceStep[];
}

/** One submission's steps grouped by the check that took them, each group in start order. */
export function groupSteps(steps: TraceStep[], submissionId: string): SubmissionSteps {
  const byCondition = new Map<string, TraceStep[]>();
  const run: TraceStep[] = [];
  const mine = steps.filter((s) => s.submission_id === submissionId).sort((a, b) => a.seq - b.seq);
  for (const s of mine) {
    if (s.condition_id === null) run.push(s);
    else {
      const list = byCondition.get(s.condition_id);
      if (list) list.push(s);
      else byCondition.set(s.condition_id, [s]);
    }
  }
  return { byCondition, run };
}

/**
 * Every step of one submission the page may show, given each condition's
 * phase: a condition missing from `phases` shows nothing. Run-level steps show
 * their results only once every check is decided. Used for the run's figures
 * and for "Copy work log", so neither says more than the rows do.
 */
export function visibleSteps(grouped: SubmissionSteps, phases: Map<string, LogPhase>): TraceStep[] {
  const out: TraceStep[] = [];
  for (const [conditionId, steps] of grouped.byCondition) out.push(...redactSteps(steps, phases.get(conditionId) ?? "hidden"));
  const allDecided = [...phases.values()].every((p) => p === "decided");
  out.push(...redactSteps(grouped.run, allDecided ? "decided" : "running"));
  return out.sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/** Server clock minus client clock, in ms, from `trace.now` and the client's time when the bundle arrived. */
export function clockOffset(serverNowIso: string, clientNowMs: number): number {
  const server = Date.parse(serverNowIso);
  return Number.isFinite(server) ? server - clientNowMs : 0;
}

/** The server's clock now, read from the client's clock and the offset. */
export function serverTime(clientNowMs: number, offsetMs: number): number {
  return clientNowMs + offsetMs;
}

/**
 * How long a step has taken: its duration once it ended; while it runs, the
 * time since it started on the server's clock, but only when the run is live
 * and the figure is sane (never negative, never past MAX_ELAPSED_MS). Null
 * means "no end recorded": the step was cut off or the clock cannot be trusted.
 */
export function stepElapsed(step: TraceStep, serverNowMs: number | null, live: boolean): number | null {
  if (step.duration_ms !== null) return Math.max(0, step.duration_ms);
  if (!live || serverNowMs === null) return null;
  const start = Date.parse(step.started_at);
  if (!Number.isFinite(start)) return null;
  const elapsed = serverNowMs - start;
  if (elapsed > MAX_ELAPSED_MS) return null;
  return Math.max(0, elapsed);
}

/**
 * What a step's status means on screen. A step is cut off when its check ended
 * (a time limit) while it ran: the verifier ends it `failed` with
 * `detail.cut_off`, and one still "running" after its run ended reads the same.
 */
export type StepState = "running" | "done" | "failed" | "cut_off";

export function stepState(step: TraceStep, live: boolean): StepState {
  if (step.status === "running") return live ? "running" : "cut_off";
  if (step.status === "failed" && step.detail.cut_off === true) return "cut_off";
  return step.status;
}

// ---------------------------------------------------------------------------
// Waterfall
// ---------------------------------------------------------------------------

export interface Window {
  start: number;
  end: number;
}

/** A check's window: its first step's start to its last step's end (server now for a running step). Null without steps. */
export function stepWindow(steps: TraceStep[], serverNowMs: number | null, live: boolean): Window | null {
  let start = Infinity;
  let end = -Infinity;
  for (const s of steps) {
    const t = Date.parse(s.started_at);
    if (!Number.isFinite(t)) continue;
    start = Math.min(start, t);
    end = Math.max(end, t + (stepElapsed(s, serverNowMs, live) ?? 0));
  }
  if (!Number.isFinite(start)) return null;
  return { start, end: Math.max(start, end) };
}

/** A step's bar in its check's window, as fractions 0..1 of the window: where it starts and how wide it is. */
export function stepBar(step: TraceStep, window: Window, serverNowMs: number | null, live: boolean): { offset: number; width: number } {
  const span = window.end - window.start;
  const t = Date.parse(step.started_at);
  if (span <= 0 || !Number.isFinite(t)) return { offset: 0, width: span <= 0 ? 1 : 0 };
  const offset = clamp01((t - window.start) / span);
  const width = clamp01((stepElapsed(step, serverNowMs, live) ?? 0) / span);
  return { offset, width: Math.min(width, 1 - offset) };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Run figures
// ---------------------------------------------------------------------------

export interface KindFigure {
  kind: TraceStepKind;
  count: number;
  /** Summed step time; concurrent steps each count their own time. */
  ms: number;
}

export interface RunMetrics {
  total: number;
  running: number;
  /** Steps that failed or were cut off. */
  failed: number;
  /** Wall clock: first start to last end, or to server now while a step runs. Null without steps. */
  elapsedMs: number | null;
  /** Only the kinds that occurred, in KIND_ORDER. */
  byKind: KindFigure[];
}

export function runMetrics(steps: TraceStep[], serverNowMs: number | null, live: boolean): RunMetrics {
  const counts = new Map<TraceStepKind, KindFigure>();
  let running = 0;
  let failed = 0;
  for (const s of steps) {
    const state = stepState(s, live);
    if (state === "running") running++;
    if (state === "failed" || state === "cut_off") failed++;
    const fig = counts.get(s.kind) ?? { kind: s.kind, count: 0, ms: 0 };
    fig.count++;
    fig.ms += stepElapsed(s, serverNowMs, live) ?? 0;
    counts.set(s.kind, fig);
  }
  const window = stepWindow(steps, serverNowMs, live);
  return {
    total: steps.length,
    running,
    failed,
    elapsedMs: window ? window.end - window.start : null,
    byKind: KIND_ORDER.flatMap((k) => {
      const f = counts.get(k);
      return f ? [f] : [];
    }),
  };
}

// ---------------------------------------------------------------------------
// Words and figures
// ---------------------------------------------------------------------------

/**
 * "340 ms" under a second, "4.2 s" under a minute, "1:05" beyond. A running
 * step's time (`running`) is always in tenths of a second under a minute, so
 * the figure ticks without changing its unit.
 */
export function formatDuration(ms: number, running = false): string {
  const v = Math.max(0, ms);
  if (v < 1000 && !running) return `${Math.round(v)} ms`;
  if (v < 60_000) {
    const tenths = Math.floor(v / 100) / 10;
    // Rounding 59.96 s up would read "60.0 s"; the floor keeps a ticking figure from running ahead.
    return `${(running ? tenths : Math.min(59.9, Math.round(v / 100) / 10)).toFixed(1)} s`;
  }
  const total = Math.floor(v / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "Nov 12 02:44:12.083": the audit tape's time to the millisecond, in the given zone. */
export function formatStepTime(iso: string, zone: "local" | "utc"): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: zone === "utc" ? "UTC" : undefined });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: zone === "utc" ? "UTC" : undefined,
  });
  return `${date} ${time}.${String(d.getUTCMilliseconds()).padStart(3, "0")}${zone === "utc" ? " UTC" : ""}`;
}

/** A fact's value as text: facts are data, never markup. */
export function factText(value: TraceFacts[string]): string {
  if (value === null) return "none";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** "status_code" -> "status code". */
export function factLabel(key: string): string {
  return key.replace(/[_-]+/g, " ").trim();
}

/** The summary line of a decided check's log: "Work log · 9 steps · 4.2 s · 1 failed step". */
export function logSummary(m: RunMetrics): string {
  const parts = [`${m.total} step${m.total === 1 ? "" : "s"}`];
  if (m.elapsedMs !== null) parts.push(formatDuration(m.elapsedMs));
  if (m.failed > 0) parts.push(`${m.failed} failed step${m.failed === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
