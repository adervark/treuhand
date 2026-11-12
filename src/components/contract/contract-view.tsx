"use client";

/**
 * The contract page, a terminal for one contract: the track it travels, where
 * the money is, every test with its evidence, what the viewer can do, and the
 * audit tape. Data comes
 * from `GET /api/contracts/[id]`, polled quickly while the verifier runs and
 * slowly otherwise; `POST /api/sweep` runs while the contract waits on a
 * deadline or a payout.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Identity, Party } from "@/lib/types";
import { api, ApiError, errorMessage, type ContractBundle, type SweepResult } from "../api";
import { ConditionsEditor, toEditable, validateConditions, type ConditionErrors, type EditableCondition } from "../conditions-editor";
import { CONTRACT_TYPE_META, formatCents, shortId, STATE_META } from "../format";
import { IconArrowLeft, IconArrowRight, IconClock, IconCode, IconGlobe, IconShield } from "../icons";
import { LocalTime, RelativeTime, useNow } from "../time";
import { usePolling } from "../use-polling";
import { RoleMark } from "../role-mark";
import { Banner, Button, Card, CardHeader, cx, StateChip, TONE_DOT, TONE_TEXT } from "../ui";
import { YourMove, type ActionState, type Run } from "./actions";
import { AuditTrail } from "./audit-trail";
import { Checklist } from "./checklist";
import { DisputeCard } from "./dispute-card";
import { manipulationOf } from "./evidence";
import { contractNotice, SWEPT_ACTIONS } from "./money";
import { MoneyFlowBand } from "./money-flow-band";
import { ReceiptPanel } from "./receipt-panel";
import { Recap } from "./recap";
import { StateRail } from "./state-rail";
import { useStagedRows } from "./staged-rows";
import { attemptTally, conditionRows, summarize, type ConditionRow, type Outcome } from "./verdicts";
import { groupSteps, logPhase, visibleSteps, type LogPhase } from "./work-log";
import { RunTelemetry, useServerNow, type WorkLogEnv } from "./work-log-view";
import type { TraceStepKind } from "@/lib/contract/service";

const FAST_POLL_MS = 1200;
const SLOW_POLL_MS = 8000;

function useContractBundle(id: string, role: Party) {
  const [bundle, setBundle] = useState<ContractBundle | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const data = await api<ContractBundle>(`/api/contracts/${id}`);
      if (mine !== seq.current) return;
      setBundle(data);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [id]);

  const state = bundle?.contract.state;
  const live =
    state === "SUBMITTED" ||
    (state === "VERIFYING" && (bundle?.verification === null || bundle?.verification?.status === "running")) ||
    Boolean(bundle?.activity.in_progress);

  // Loads now, polls (fast while the verifier or a payment runs), and reloads when the
  // viewer switches role, because the allowed actions depend on it.
  usePolling(load, live ? FAST_POLL_MS : SLOW_POLL_MS, `${id}:${role}`);

  return { bundle, error, load };
}

export interface SweepStatus {
  at: number;
  error: string | null;
  note: string | null;
}

/** Runs `POST /api/sweep` while the contract waits on its deadline or a payout. */
function useSweep(bundle: ContractBundle | null, reload: () => Promise<void>): SweepStatus | null {
  const [status, setStatus] = useState<SweepStatus | null>(null);
  const contract = bundle?.contract;
  const waitingOnPayout = contract?.state === "PASSED";
  const waitingOnDeadline = contract?.state === "FUNDED" || contract?.state === "FAILED";
  const waitingOnSplit =
    contract?.state === "DISPUTED" && bundle?.dispute?.payer_accepted === true && bundle?.dispute?.worker_accepted === true;
  // Only the sweep's own actions are retried by it; a failed funding or mediation waits for a person.
  const retrying = SWEPT_ACTIONS.has(bundle?.activity.last_failure?.action ?? "");
  const active = Boolean(contract) && (waitingOnPayout || waitingOnDeadline || waitingOnSplit || retrying);
  const period = waitingOnPayout || waitingOnSplit ? 10_000 : 30_000;
  const deadline = contract?.deadline_at;
  const contractId = contract?.id;

  useEffect(() => {
    if (!active || !contractId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const result = await api<SweepResult>("/api/sweep", { method: "POST" });
        if (stopped) return;
        const mine = result.errors.find((e) => e.contract_id === contractId);
        setStatus({ at: Date.now(), error: mine ? mine.message : null, note: null });
        await reload();
      } catch (err) {
        if (!stopped) setStatus({ at: Date.now(), error: errorMessage(err), note: null });
      }
    };
    const timers: ReturnType<typeof setTimeout>[] = [];
    const untilDeadline = deadline ? Date.parse(deadline) - Date.now() : Infinity;
    // First check soon after the page opens; then on the period; and right after the deadline if it is close.
    timers.push(setTimeout(tick, untilDeadline <= 0 || waitingOnPayout || waitingOnSplit ? 400 : 2_000));
    if (untilDeadline > 0 && untilDeadline < 30 * 60_000) timers.push(setTimeout(tick, untilDeadline + 1_500));
    const interval = setInterval(tick, period);
    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
      clearInterval(interval);
    };
  }, [active, contractId, deadline, period, reload, waitingOnPayout, waitingOnSplit]);

  return active ? status : null;
}

export function ContractView({ id, role, identities }: { id: string; role: Party; identities: Identity[] }) {
  const { bundle, error, load } = useContractBundle(id, role);
  const sweep = useSweep(bundle, load);
  const [action, setAction] = useState<ActionState>({ pending: null, failure: null });
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const now = useNow();

  // The verdict moment (staged-rows.ts): verdicts of the latest run that arrive with the page open play into the
  // run log one by one. Until they have, every panel but the run log, the failure banner and the dispute card holds
  // the contract as it was before they arrived, so nothing announces a result the run log has not shown yet.
  const latestRows = useMemo(() => (bundle ? conditionRows(bundle, bundle.submissions[0] ?? null) : []), [bundle]);
  const verdictIds = useMemo(() => (bundle ? bundle.verdicts.map((v) => v.id) : null), [bundle]);
  const reveal = useStagedRows(latestRows, verdictIds);
  const [still, setStill] = useState(bundle);
  if (!reveal.playing && still !== bundle) setStill(bundle);

  const run: Run = useCallback(
    async (key, fn) => {
      setAction({ pending: key, failure: null });
      try {
        await fn();
        await load();
        setAction({ pending: null, failure: null });
        // Work just went to the verifier: bring the checklist into view so each verdict is seen landing.
        if (key === "submit" || key === "rerun") {
          document.getElementById("tests")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return true;
      } catch (err) {
        setAction({ pending: null, failure: { key, message: errorMessage(err) } });
        await load();
        return false;
      }
    },
    [load],
  );

  if (!bundle) {
    if (error) {
      const missing = error instanceof ApiError && error.code === "NOT_FOUND";
      return (
        <div className="mx-auto max-w-2xl py-10">
          <Banner
            title={missing ? "No contract with this id" : "This contract could not be loaded"}
            action={
              missing ? (
                <Link href="/contracts" className="text-sm font-medium text-ink underline">
                  All contracts
                </Link>
              ) : (
                <Button variant="secondary" size="sm" onClick={() => void load()}>
                  Try again
                </Button>
              )
            }
          >
            {error.message}
          </Banner>
        </div>
      );
    }
    return <ContractSkeleton />;
  }

  // (Not across a switch of viewer: that page's actions belong to the other party.)
  const view = reveal.playing && still && still.viewer.role === bundle.viewer.role ? still : bundle;
  const { contract } = view;
  const roleMismatch = bundle.viewer.role !== role;
  const selected = bundle.submissions.find((s) => s.id === attemptId) ?? bundle.submissions[0] ?? null;
  const canEdit = bundle.allowed_actions.includes("edit_conditions") && !roleMismatch;

  // Settled without a dispute: PayPal returned every payout attempt and the payer was refunded.
  const refundedAfterPayouts = contract.state === "SETTLED" && !view.dispute;
  // A failed money step, an agreed split or a passed deadline overrides the state's own words.
  const notice = contractNotice(view, now);
  const stateTone = notice?.tone ?? (refundedAfterPayouts ? "returned" : STATE_META[contract.state].tone);
  const stateBlurb = notice?.text ?? (refundedAfterPayouts ? "PayPal could not pay the worker, so the payer was refunded." : STATE_META[contract.state].blurb);

  return (
    <div className="flex flex-col gap-3 3xl:h-[max(44rem,calc(100dvh_-_var(--shell-chrome)))]">
      <ContractHeader bundle={view} identities={identities} />

      {error ? (
        <Banner tone="warn" title="Live updates paused">
          {error.message} Retrying automatically.
        </Banner>
      ) : null}
      {bundle.activity.last_failure ? <FailureBanner failure={bundle.activity.last_failure} role={role} /> : null}

      {/*
        Below 1024 px one column; from 1024 px the track and money flow span the
        page above the run log and a sticky "Your move" column. From 3xl (1760 px)
        the page is exactly the window's height and nothing on it scrolls but
        panels: money and actions on the left (track, money flow, then "Your
        move" beside the audit tape), the tests on the right. From 4xl (2400 px)
        three columns: track, money flow and audit tape; dispute and tests; and
        "Your move" as a rail on the right. Where a wrapper is `display:
        contents`, its panels are placed in the page grid directly.
      */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_23.75rem] 3xl:min-h-0 3xl:flex-1 3xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] 3xl:grid-rows-[minmax(0,1fr)] 4xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_30rem] 4xl:grid-rows-[auto_auto_minmax(0,1fr)]">
        <div className="contents 3xl:col-start-1 3xl:row-start-1 3xl:flex 3xl:min-h-0 3xl:min-w-0 3xl:flex-col 3xl:gap-3 4xl:contents">
          <Card className="overflow-hidden lg:col-span-2 lg:row-start-1 3xl:shrink-0 4xl:col-span-1 4xl:col-start-1 4xl:row-start-1">
            <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule bg-head px-3 py-1.5">
              <h2 className="panel-title">Track</h2>
              <p className={cx("text-[0.8125rem] font-semibold", stateTone === "neutral" ? "text-ink" : TONE_TEXT[stateTone])} aria-live="polite">
                {stateBlurb}
              </p>
            </header>
            <div className="px-1 pt-3 pb-3.5 sm:px-4">
              <StateRail state={contract.state} events={view.events} hasSubmissions={view.submissions.length > 0} />
            </div>
          </Card>

          <div className="min-w-0 lg:col-span-2 lg:row-start-2 3xl:shrink-0 4xl:col-span-1 4xl:col-start-1 4xl:row-start-2">
            <MoneyFlowBand bundle={view} identities={identities} />
            {sweep && !(sweep.error && bundle.activity.last_failure) ? <SweepNote status={sweep} /> : null}
          </div>

          <div className="contents 3xl:grid 3xl:min-h-0 3xl:flex-1 3xl:grid-cols-[26rem_minmax(0,1fr)] 3xl:grid-rows-[minmax(0,1fr)] 3xl:gap-3 4xl:contents">
            <div className="flex min-w-0 flex-col gap-3 *:shrink-0 lg:sticky lg:top-[4.25rem] lg:col-start-2 lg:row-span-2 lg:row-start-3 lg:max-h-[calc(100dvh_-_5.25rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain 3xl:static 3xl:col-start-1 3xl:row-span-1 3xl:row-start-1 3xl:max-h-none 3xl:min-h-0 3xl:self-stretch 4xl:col-start-3 4xl:row-[1/4]">
              {roleMismatch ? (
                <div className="flex items-center justify-center gap-2 border border-rule bg-surface px-5 py-6 tnum text-[0.75rem] text-ink-3">
                  Switching to the {role}…
                </div>
              ) : (
                <YourMove
                  bundle={view}
                  role={role}
                  identities={identities}
                  run={run}
                  state={action}
                  editing={editing}
                  onEdit={setEditing}
                  reload={() => void load()}
                />
              )}
              {/* While a run plays in, its receipt waits for it: the panel says one is signed when the run finishes. */}
              <ReceiptPanel bundle={reveal.playing ? { ...view, receipt: null } : view} />
            </div>

            <Card className="order-last flex min-w-0 flex-col overflow-hidden lg:order-none lg:col-start-1 lg:row-start-4 3xl:col-start-2 3xl:row-start-1 3xl:max-h-full 3xl:min-h-0 3xl:self-start 4xl:col-start-1 4xl:row-start-3">
              <CardHeader
                eyebrow="Audit tape"
                aside={<span className="tnum text-[0.72rem] text-ink-2">{view.events.length} events · newest first</span>}
              />
              <div className="max-h-[30rem] overflow-y-auto 3xl:max-h-none 3xl:min-h-0 3xl:flex-1">
                <AuditTrail events={view.events} currency={contract.currency} />
              </div>
            </Card>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3 lg:col-start-1 lg:row-start-3 3xl:col-start-2 3xl:row-start-1 3xl:min-h-0 3xl:overflow-y-auto 3xl:overscroll-contain 4xl:row-[1/4]">
          {/* Never shrunk by the full-height column from 3xl: its overflow-hidden card would clip the proposal and its buttons. */}
          {bundle.dispute ? (
            <div className="shrink-0">
              <DisputeCard contract={contract} dispute={bundle.dispute} />
            </div>
          ) : null}

          <div id="tests" className="scroll-mt-20 3xl:flex 3xl:grow 3xl:flex-col">
            {editing && canEdit ? (
              <EditTests bundle={bundle} run={run} pending={action.pending === "edit"} error={action.failure?.key === "edit" ? action.failure.message : null} onDone={() => setEditing(false)} />
            ) : (
              <TestsCard
                bundle={bundle}
                selectedId={selected?.id ?? null}
                staged={selected && selected.id === bundle.submissions[0]?.id ? reveal.rows : null}
                latestRows={reveal.rows}
                onSelect={setAttemptId}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function humanStep(step: string): string {
  const map: Record<string, string> = {
    capture: "Capturing the hold",
    payout: "The payout to the worker",
    payout_status: "Checking the payout with PayPal",
    void: "Releasing the hold",
    refund: "The refund to the payer",
    settle: "Paying the worker",
    authorize: "Placing the hold",
    mediate: "Mediation",
    verify: "Verification",
  };
  return map[step] ?? step.charAt(0).toUpperCase() + step.slice(1).replace(/_/g, " ");
}

/**
 * The last failed step, saying what happens next. Only the payer can retry
 * funding, and PayPal's raw error stays on the stored event (the API returns
 * it) rather than on the page.
 */
function FailureBanner({ failure, role }: { failure: NonNullable<ContractBundle["activity"]["last_failure"]>; role: Party }) {
  const at = (
    <span className="text-ink-3">
      (<LocalTime iso={failure.at} />)
    </span>
  );
  if (failure.action === "fund") {
    return (
      <Banner tone="warn" title="Funding did not complete">
        {failure.step === "void_mismatched_hold" ? "PayPal placed a hold that did not match this contract and it could not be released. " : null}
        {role === "payer" ? "Press the PayPal button to try again." : "The payer can try again with the PayPal button."} {at}
      </Banner>
    );
  }
  if (failure.action === "mediate") {
    return (
      <Banner tone="warn" title={failure.step === "validate_proposal" ? "The mediator's proposal was not valid" : "The mediator did not answer"}>
        {failure.message} Either party can send their side to the mediator again to retry. {at}
      </Banner>
    );
  }
  const retry = !SWEPT_ACTIONS.has(failure.action)
    ? ""
    : failure.step === "payout" || failure.step === "payout_status"
      ? " Treuhand checks with PayPal again automatically."
      : " Treuhand tries again automatically.";
  // PayPal's raw error (request, HTTP status, debug id) is kept on the stored event, not shown here.
  const message = /\bPayPal (?:GET|POST|PUT|PATCH|DELETE) \S+ failed: HTTP \d+/.test(failure.message) ? "PayPal refused the request." : failure.message;
  return (
    <Banner tone="warn" title={`${humanStep(failure.step)} did not go through`}>
      {message}
      {retry} {at}
    </Banner>
  );
}

function ContractHeader({ bundle, identities }: { bundle: ContractBundle; identities: Identity[] }) {
  const { contract } = bundle;
  const payer = identities.find((i) => i.email === contract.payer_email);
  const worker = identities.find((i) => i.email === contract.worker_email);
  const TypeIcon = contract.type === "code_bounty" ? IconCode : IconGlobe;
  const now = useNow();
  const terminal = ["PAID", "EXPIRED", "SETTLED"].includes(contract.state);
  const overdue = !terminal && now !== null && Date.parse(contract.deadline_at) < now;

  return (
    <header className="flex flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem] text-ink-3">
        <Link href="/contracts" className="inline-flex items-center gap-1 text-ink-2 hover:text-ink">
          <IconArrowLeft size={13} /> Contracts
        </Link>
        <span aria-hidden>/</span>
        <span className="inline-flex items-center gap-1">
          <TypeIcon size={12} /> {CONTRACT_TYPE_META[contract.type].label}
        </span>
        <span aria-hidden>·</span>
        <span>
          ID <span className="font-code text-ink-2">{shortId(contract.id)}</span>
        </span>
      </p>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <h1 className="min-w-0 text-[1.375rem] leading-[1.75rem] font-semibold text-balance text-ink">
          {contract.title}
        </h1>
        <div className="flex items-center gap-3">
          <span className="figure-hero text-[1.375rem] leading-none text-ink">{formatCents(contract.amount_cents, contract.currency)}</span>
          <StateChip state={contract.state} size="md" />
        </div>
      </div>
      <dl className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[0.8125rem]">
        <div className="flex items-center gap-2">
          <dt className="sr-only">Parties</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <Party role="payer" name={payer?.display_name} email={contract.payer_email} />
            <IconArrowRight size={13} className="text-ink-3" aria-hidden />
            <Party role="worker" name={worker?.display_name} email={contract.worker_email} />
          </dd>
        </div>
        <div className="flex items-center gap-1.5 text-ink-2">
          <IconClock size={14} className="text-ink-3" />
          <dt className="label">Deadline</dt>
          <dd className={cx("tnum text-[0.75rem]", overdue ? "font-semibold text-fail" : "text-ink")}>
            <LocalTime iso={contract.deadline_at} /> <span className="text-ink-3">(<RelativeTime iso={contract.deadline_at} />)</span>
          </dd>
        </div>
      </dl>
      <Recap bundle={bundle} worker={worker?.display_name ?? contract.worker_email} />
    </header>
  );
}

function Party({ role, name, email }: { role: Party; name?: string; email: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={email}>
      <RoleMark role={role} />
      <span className={cx("font-semibold", role === "payer" ? "text-payer" : "text-worker")}>{role === "payer" ? "Payer" : "Worker"}</span>
      <span className="text-ink-2">{name ?? email}</span>
    </span>
  );
}

function SweepNote({ status }: { status: SweepStatus }) {
  return (
    <p className={cx("mt-1.5 px-1 tnum text-[0.64rem] leading-4", status.error ? "text-disputed" : "text-ink-3")} role="status">
      {status.error ? (
        <>Background check with PayPal failed: {status.error}</>
      ) : (
        <>
          Treuhand checks deadlines and payouts with PayPal automatically · last check{" "}
          <RelativeTime iso={new Date(status.at).toISOString()} />
        </>
      )}
    </p>
  );
}

/** Pass/fail tally of the rows as the run log shows them now (a verdict still held back or being voted on is not counted). */
function rowTally(rows: ConditionRow[]): { passed: number; failed: number; other: number } {
  const sum = summarize(rows.filter((r) => r.voting === undefined));
  return { passed: sum.passed, failed: sum.failed, other: sum.inconclusive };
}

function TestsCard({
  bundle,
  selectedId,
  staged,
  latestRows,
  onSelect,
}: {
  bundle: ContractBundle;
  selectedId: string | null;
  /** The latest run's rows as they play in (staged-rows.ts), when that run is the one shown; the headline and meter follow them. */
  staged: ConditionRow[] | null;
  /** The latest run's rows as they play in, whichever attempt is shown: the attempt switcher's tally for that run follows them. */
  latestRows: ConditionRow[];
  onSelect: (id: string) => void;
}) {
  const selected = bundle.submissions.find((s) => s.id === selectedId) ?? null;
  const reported = useMemo(() => conditionRows(bundle, selected), [bundle, selected]);
  const rows = staged ?? reported;
  const sum = summarize(rows);
  const isLatest = selected !== null && selected.id === bundle.submissions[0]?.id;
  const attempts = [...bundle.submissions].reverse(); // oldest first, numbered 1..n

  let headline: { text: string; tone: string };
  if (!selected) headline = { text: `${sum.total} test${sum.total === 1 ? "" : "s"}, run when the work is submitted`, tone: "text-ink" };
  else if (sum.pending > 0 && isLatest && rows.some((r) => r.outcome === "checking" || r.outcome === "queued"))
    headline = { text: `Checking… ${sum.passed + sum.failed + sum.inconclusive} of ${sum.total} done`, tone: "text-machine" };
  else if (sum.failed > 0) headline = { text: `${sum.failed} of ${sum.total} failed`, tone: "text-fail" };
  else if (sum.inconclusive > 0) headline = { text: `${sum.inconclusive} of ${sum.total} inconclusive`, tone: "text-inconclusive" };
  else if (sum.passed === sum.total) headline = { text: `All ${sum.total} passed`, tone: "text-paid" };
  else headline = { text: `${sum.passed} of ${sum.total} passed`, tone: "text-ink" };

  const manipulated = rows.filter((r) => r.verdict && r.voting === undefined && manipulationOf(r.verdict.evidence));

  // The verifier's work log for this attempt (work-log.ts): live while its run is running, a record afterwards.
  const live = selected !== null && bundle.verification?.status === "running" && bundle.verification.submission_id === selected.id;
  const serverNow = useServerNow(bundle.trace.now, live);
  const [filter, setFilter] = useState<TraceStepKind | null>(null);
  const grouped = useMemo(() => (selected ? groupSteps(bundle.trace.steps, selected.id) : null), [bundle.trace.steps, selected]);
  const phases = new Map<string, LogPhase>(rows.map((r) => [r.condition.id, logPhase(r)]));
  const shownSteps = grouped ? visibleSteps(grouped, phases) : [];
  const hasSteps = grouped !== null && (grouped.run.length > 0 || grouped.byCondition.size > 0);
  // A kind filter only means something while that kind is on screen.
  const activeFilter = filter !== null && shownSteps.some((s) => s.kind === filter) ? filter : null;
  const env: WorkLogEnv = { serverNow, live, filter: activeFilter };

  return (
    <Card className="overflow-hidden 3xl:grow">
      <header className="border-b border-rule">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-head px-3 py-1">
          <div className="flex min-w-0 items-baseline gap-2.5 py-0.5">
            <h2 className="panel-title">Tests · run log</h2>
            <span className="truncate text-[0.72rem] text-ink-2 max-sm:hidden">
              {bundle.contract.state === "DRAFT" ? "both parties sign these before any money moves" : "the conditions both parties signed"}
            </span>
          </div>
          {attempts.length > 1 ? (
            <div role="group" aria-label="Attempts" className="flex flex-wrap">
              {attempts.map((s, i) => {
                // The latest attempt's tally follows the run log as it plays in, so it never counts a verdict the log has not shown.
                const tally = s.id === bundle.submissions[0]?.id ? rowTally(latestRows) : attemptTally(bundle, s.id);
                const active = s.id === selected?.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onSelect(s.id)}
                    className={cx(
                      "flex h-6 items-center gap-1.5 border-l border-rule px-2 tnum text-[0.72rem] font-semibold transition-colors duration-100 first:border-l-0",
                      active ? "bg-accent-fill text-accent-on" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                    )}
                  >
                    Attempt {i + 1}
                    <span>
                      <span className={active ? undefined : "text-paid"}>{tally.passed}✓</span>
                      {tally.failed > 0 ? <span className={cx("ml-1", !active && "text-fail")}>{tally.failed}✕</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
          <p className={cx("tnum text-[0.9375rem] leading-6 font-semibold", headline.tone)} aria-live="polite">
            {headline.text}
          </p>
          <Meter rows={rows} />
          {manipulated.length > 0 ? (
            <a
              href={`#manipulation-${manipulated[0].condition.id}`}
              className="inline-flex items-center rounded-xs bg-alarm-fill tnum text-[0.7rem] font-semibold text-alarm-on"
            >
              <span className="flex items-center gap-1.5 px-1.5 py-0.5">
                <IconShield size={13} strokeWidth={2.4} />
                {manipulated.length === 1 ? "1 manipulation attempt" : `${manipulated.length} manipulation attempts`}
              </span>
            </a>
          ) : null}
        </div>
        {selected && hasSteps ? (
          <RunTelemetry
            steps={shownSteps}
            env={env}
            onFilter={setFilter}
            submissionId={selected.id}
            redacted={[...phases.values()].some((p) => p !== "decided")}
          />
        ) : null}
      </header>
      {selected && !isLatest ? (
        <p className="border-b border-rule bg-disputed-soft px-4 py-2 text-[0.8rem] text-disputed">
          You are looking at an earlier attempt.{" "}
          <button type="button" className="font-semibold underline" onClick={() => onSelect(bundle.submissions[0].id)}>
            Show the latest
          </button>
        </p>
      ) : null}
      {bundle.notes.length > 0 ? <DrafterNotes notes={bundle.notes} /> : null}
      {isLatest && bundle.verification && (bundle.verification.status === "inconclusive" || bundle.verification.status === "error") ? (
        <div className="border-b border-rule px-4 py-3">
          <Banner tone="warn" title={bundle.verification.status === "error" ? "The verification run crashed" : "Some checks could not complete"}>
            {bundle.verification.message ?? "No reason was recorded."} Nothing was decided and no money moved. Either party can re-run the checks.
          </Banner>
        </div>
      ) : null}
      <Checklist rows={rows} submission={selected} receipt={bundle.receipt} workLog={grouped && hasSteps ? { steps: grouped, env } : null} />
    </Card>
  );
}

const METER_TONE: Record<Outcome, string> = {
  pass: TONE_DOT.paid,
  fail: TONE_DOT.fail,
  inconclusive: TONE_DOT.inconclusive,
  checking: cx(TONE_DOT.machine, "pulse-dot"),
  queued: "bg-rule-strong",
  not_run: "bg-rule-strong",
};

/** One segment per test, coloured by its verdict: the run read as a shape. */
function Meter({ rows }: { rows: ConditionRow[] }) {
  return (
    <span className="flex items-center gap-0.5" aria-hidden>
      {rows.map((r) => (
        <span key={r.condition.id} className={cx("h-2.5 w-6 rounded-[1px] transition-colors duration-300 sm:w-8", METER_TONE[r.outcome])} />
      ))}
    </span>
  );
}

/** The drafter's notes: where it narrowed or interpreted the deal. Both parties see them before signing. */
export function DrafterNotes({ notes, className }: { notes: string[]; className?: string }) {
  return (
    <div className={cx("border-b border-rule bg-machine-soft px-4 py-3", className)}>
      <p className="label text-machine">AI drafter · how it read the deal</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {notes.map((n, i) => (
          <li key={i} className="flex gap-2 tnum text-[0.75rem] leading-[1.2rem] text-ink">
            <span className="shrink-0 text-machine" aria-hidden>
                  ·
                </span>
            {n}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EditTests({
  bundle,
  run,
  pending,
  error,
  onDone,
}: {
  bundle: ContractBundle;
  run: Run;
  pending: boolean;
  error: string | null;
  onDone: () => void;
}) {
  const [conditions, setConditions] = useState<EditableCondition[]>(() => toEditable(bundle.conditions));
  const [errors, setErrors] = useState<ConditionErrors[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const { contract } = bundle;
  const signed = Boolean(contract.payer_signed_at || contract.worker_signed_at);

  return (
    <Card>
      <CardHeader eyebrow="Editing the tests" title="Change what the verifier will check" />
      <div className="flex flex-col gap-4 px-4 py-4">
        {signed ? (
          <Banner tone="warn" title="Saving clears both signatures">
            Both parties sign again after any change, so neither side is held to terms they did not see.
          </Banner>
        ) : null}
        <ConditionsEditor type={contract.type} conditions={conditions} onChange={setConditions} errors={errors} disabled={pending} />
        {message ? <p className="text-sm font-medium text-fail">{message}</p> : null}
        {error ? <Banner title="Not saved">{error}</Banner> : null}
        <div className="flex gap-2">
          <Button
            busy={pending}
            onClick={async () => {
              const result = validateConditions(contract.type, conditions);
              if (!result.ok) {
                setErrors(result.errors);
                setMessage(result.message);
                return;
              }
              setErrors([]);
              setMessage(null);
              const ok = await run("edit", () =>
                api(`/api/contracts/${contract.id}/conditions`, { method: "PATCH", body: { conditions: result.value } }),
              );
              if (ok) onDone();
            }}
          >
            Save the tests
          </Button>
          <Button variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** A panel's outline and title strip, for the skeleton. */
function SkeletonPanel({ className }: { className?: string }) {
  return (
    <div className={cx("flex flex-col border border-rule bg-surface", className)}>
      <div className="h-[1.9rem] shrink-0 border-b border-rule bg-head" />
    </div>
  );
}

/** The page's own grid with empty panels at their usual sizes, so nothing jumps when the contract arrives. */
function ContractSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-3 3xl:h-[max(44rem,calc(100dvh_-_var(--shell-chrome)))]" aria-busy="true" aria-label="Loading the contract">
      <div className="flex flex-col gap-1.5">
        <div className="h-4 w-56 rounded-xs bg-inset" />
        <div className="h-7 w-2/3 max-w-xl rounded-xs bg-inset" />
        <div className="h-5 w-1/2 max-w-md rounded-xs bg-inset" />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_23.75rem] 3xl:min-h-0 3xl:flex-1 3xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] 4xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_30rem]">
        <div className="contents 3xl:col-start-1 3xl:row-start-1 3xl:flex 3xl:min-h-0 3xl:flex-col 3xl:gap-3">
          <SkeletonPanel className="h-[7.6rem] lg:col-span-2 lg:row-start-1 3xl:shrink-0" />
          <SkeletonPanel className="h-[19rem] lg:col-span-2 lg:row-start-2 3xl:shrink-0" />
          <SkeletonPanel className="hidden 3xl:flex 3xl:min-h-0 3xl:flex-1" />
        </div>
        <SkeletonPanel className="h-40 lg:col-start-2 lg:row-start-3 3xl:hidden" />
        <SkeletonPanel className="h-96 lg:col-start-1 lg:row-start-3 3xl:col-start-2 3xl:row-start-1 3xl:h-auto" />
        <div className="hidden flex-col gap-3 self-start 4xl:col-start-3 4xl:row-start-1 4xl:flex">
          <SkeletonPanel className="h-28" />
          <SkeletonPanel className="h-80" />
        </div>
      </div>
      <span className="sr-only">Loading</span>
    </div>
  );
}
