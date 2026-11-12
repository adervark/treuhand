/**
 * Where the contract is along its track (docs/design.md, "State is a place on
 * a line"). The happy path runs left to right; failure, expiry and disputes
 * branch off at the station where they happened.
 */
import type { ClauseEvent, ContractState } from "@/lib/types";
import { STATE_META, type Tone } from "../format";
import { IconCheck, IconX } from "../icons";
import { cx, TONE_DOT, TONE_TEXT } from "../ui";

const PATH: ContractState[] = ["DRAFT", "SIGNED", "FUNDED", "SUBMITTED", "VERIFYING", "PASSED", "PAID"];

interface Branch {
  at: number;
  label: string;
  tone: Tone;
  note: string;
}

/** The state the contract was in just before it entered `state`, from the audit trail. */
function enteredFrom(events: ClauseEvent[], state: ContractState): ContractState | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "STATE_CHANGED" && e.detail.to === state && typeof e.detail.from === "string") {
      return e.detail.from as ContractState;
    }
  }
  return null;
}

export function railModel(
  state: ContractState,
  events: ClauseEvent[],
  hasSubmissions: boolean,
): { reached: number; branch: Branch | null } {
  const onPath = PATH.indexOf(state);
  if (onPath >= 0) return { reached: onPath, branch: null };

  if (state === "FAILED") {
    return { reached: 4, branch: { at: 5, label: "Failed", tone: "fail", note: "worker can resubmit" } };
  }
  if (state === "EXPIRED") {
    const from = enteredFrom(events, "EXPIRED") ?? (hasSubmissions ? "FAILED" : "FUNDED");
    const reached = from === "FAILED" ? 4 : 2;
    return { reached, branch: { at: reached + 1, label: "Expired", tone: "returned", note: "hold released" } };
  }
  // Settled straight from PASSED: PayPal returned every payout, so the payer was refunded.
  if (state === "SETTLED" && enteredFrom(events, "SETTLED") === "PASSED") {
    return { reached: 5, branch: { at: 6, label: STATE_META.SETTLED.label, tone: "returned", note: "payer refunded" } };
  }
  // DISPUTED, ESCALATED, SETTLED: branch off where the dispute was opened.
  const disputedFrom = enteredFrom(events, "DISPUTED") ?? (hasSubmissions ? "FAILED" : "FUNDED");
  const reached = disputedFrom === "PASSED" ? 5 : disputedFrom === "FAILED" ? 4 : 2;
  const meta = STATE_META[state];
  const note = state === "SETTLED" ? "split paid" : state === "ESCALATED" ? "human review" : "mediator";
  return { reached, branch: { at: reached + 1, label: meta.label, tone: meta.tone, note } };
}

export function StateRail({
  state,
  events,
  hasSubmissions,
}: {
  state: ContractState;
  events: ClauseEvent[];
  hasSubmissions: boolean;
}) {
  const { reached, branch } = railModel(state, events, hasSubmissions);
  const finished = state === "PAID";

  return (
    <ol aria-label="Contract track" className="grid w-full grid-cols-7">
      {PATH.map((step, i) => {
        const isBranch = branch !== null && i === branch.at;
        const beyondBranch = branch !== null && i > branch.at;
        const done = i < reached || (i === reached && (finished || branch !== null));
        const current = (!branch && i === reached && !finished) || isBranch;
        const label = isBranch ? branch.label : STATE_META[step].label;
        const tone: Tone = isBranch ? branch.tone : STATE_META[step].tone;
        const lineDone = i <= reached;

        return (
          <li
            key={step}
            aria-current={current ? "step" : undefined}
            className={cx("relative flex min-w-0 flex-col items-center", beyondBranch && "opacity-40")}
          >
            {/* the rule from the previous station */}
            {i > 0 ? (
              <span
                aria-hidden
                className={cx(
                  "absolute top-[1.4375rem] right-1/2 h-0.5 w-full",
                  lineDone ? "bg-ink" : isBranch ? TONE_DOT[tone] : "bg-rule-strong",
                  isBranch && "opacity-70",
                )}
              />
            ) : null}
            <span className={cx("tnum text-[0.62rem] leading-3 font-semibold", current ? (tone === "neutral" ? "text-ink" : TONE_TEXT[tone]) : "text-ink-3")}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="relative mt-1.5 grid h-5 place-items-center">
              {current ? (
                <span
                  className={cx(
                    "relative z-10 grid size-5 place-items-center rounded-xs",
                    tone === "neutral" ? "bg-ink text-ink" : cx(TONE_DOT[tone], TONE_TEXT[tone]),
                  )}
                >
                  <span className="relative grid place-items-center text-surface">
                    {isBranch && tone === "fail" ? <IconX size={13} strokeWidth={3} /> : <span className="size-1.5 rounded-[1px] bg-surface" />}
                  </span>
                </span>
              ) : done ? (
                <span className="relative z-10 grid size-3.5 place-items-center rounded-xs bg-ink text-surface">
                  <IconCheck size={11} strokeWidth={3.2} />
                </span>
              ) : (
                <span className="relative z-10 size-3 rounded-xs bg-surface ring-2 ring-rule-strong ring-inset" />
              )}
            </span>
            <span
              className={cx(
                "mt-2 max-w-full truncate px-1 text-center font-semibold text-[0.72rem] leading-4  ",
                current ? (tone === "neutral" ? "text-ink" : TONE_TEXT[tone]) : done ? "text-ink" : "text-ink-3",
                // On a phone only the current station is named, and its name may run past its column.
                current ? "max-sm:max-w-none max-sm:overflow-visible" : "max-sm:sr-only",
              )}
            >
              {label}
            </span>
            {isBranch ? <span className="max-w-full truncate px-1 text-[0.68rem] leading-4 text-ink-3 max-sm:hidden">{branch.note}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The track at list size: seven ticks with the contract's position lit, plus its name. */
export function MicroTrack({ state, events = [], hasSubmissions = false }: { state: ContractState; events?: ClauseEvent[]; hasSubmissions?: boolean }) {
  const { reached, branch } = railModel(state, events, hasSubmissions);
  const meta = STATE_META[state];
  const finished = state === "PAID";
  const position = branch ? branch.at : reached;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex items-center gap-[3px]" aria-hidden>
        {PATH.map((step, i) => (
          <span
            key={step}
            className={cx(
              "h-2.5 w-1.5 rounded-[1px]",
              i === position && !finished ? TONE_DOT[meta.tone] : i < position || finished ? "bg-ink-2" : "bg-rule-strong",
              branch && i === position && "h-2.5 w-2.5",
            )}
          />
        ))}
      </span>
      <span className={cx("font-semibold text-[0.72rem] whitespace-nowrap  ", TONE_TEXT[meta.tone])}>
        {meta.label}
      </span>
    </span>
  );
}
