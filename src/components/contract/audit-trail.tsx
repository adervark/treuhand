"use client";

/**
 * The contract's audit trail as a ledger tape, newest first: when (to the
 * second), who, what happened, and every PayPal reference involved. Wording
 * comes from the event kind and its recorded detail, never from guesses about
 * what probably happened.
 */
import type { ClauseEvent, ContractState } from "@/lib/types";
import { actorLabel, formatCents, humanize, shortId, STATE_META, type Tone } from "../format";
import { LocalTime, TapeTime } from "../time";
import { cx, StateChip, TONE_DOT, TONE_TEXT } from "../ui";

type Detail = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function cents(d: Detail, currency: string): string | null {
  return typeof d.amount_cents === "number" ? formatCents(d.amount_cents, currency) : null;
}

interface Line {
  text: string;
  tone: Tone;
  refs: [string, string][];
  state?: ContractState;
  link?: { href: string; label: string };
}

/** A recorded comment URL, linked only if it is the GitHub comment URL Treuhand builds. */
function githubCommentUrl(v: unknown): string | null {
  const url = str(v);
  return url && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+#issuecomment-\d+$/.test(url) ? url : null;
}

function describe(e: ClauseEvent, currency: string): Line {
  const d = e.detail;
  const amount = cents(d, currency);
  const refs: [string, string][] = [];
  for (const key of ["order_id", "authorization_id", "capture_id", "payout_batch_id", "refund_id", "event_id", "dispute_id", "submission_id"]) {
    const v = str(d[key]);
    // PayPal references are shown whole (they are what PayPal support asks for); our own ids are shortened.
    if (v) refs.push([humanize(key.replace(/_id$/, "")), key === "dispute_id" || key === "submission_id" ? shortId(v) : v]);
  }
  const step = str(d.step);
  switch (e.kind) {
    case "CONTRACT_CREATED":
      return { text: "Contract drafted", tone: "neutral", refs };
    case "STATE_CHANGED": {
      const to = str(d.to) as ContractState | null;
      return { text: to ? `Now ${STATE_META[to]?.label ?? humanize(to)}` : "State changed", tone: to ? STATE_META[to]?.tone ?? "neutral" : "neutral", refs, state: to ?? undefined };
    }
    case "SIGNED_OFF":
      return { text: `${actorLabel(d.party ?? d.actor).label} signed the contract`, tone: "pass", refs };
    case "SIGNOFFS_CLEARED":
      return { text: "Both sign-offs cleared because the terms changed", tone: "warn", refs };
    case "CONDITIONS_EDITED":
      return { text: `Conditions edited${typeof d.count === "number" ? ` (${d.count})` : ""}`, tone: "neutral", refs };
    case "TERMS_EDITED":
      return { text: "Terms edited", tone: "neutral", refs };
    case "ORDER_CREATED":
      return { text: `PayPal order created${amount ? ` for ${amount}` : ""}`, tone: "info", refs };
    case "FUNDS_AUTHORIZED":
      return { text: `PayPal placed a hold${amount ? ` of ${amount}` : ""} on the payer's account`, tone: "money", refs };
    case "SUBMISSION_RECEIVED":
      return { text: `Work submitted${str(d.url) ? `: ${d.url}` : ""}`, tone: "worker", refs };
    case "VERIFICATION_STARTED":
      return { text: "Verifier started checking the work", tone: "info", refs };
    case "VERIFICATION_COMPLETED": {
      const outcome = str(d.outcome) ?? str(d.status) ?? (d.all_passed === true ? "passed" : d.all_passed === false ? "failed" : null);
      return {
        text: `Verifier finished${outcome ? `: ${outcome}` : ""}`,
        tone: outcome === "passed" ? "pass" : outcome === "failed" ? "fail" : "info",
        refs,
      };
    }
    case "VERIFICATION_ERROR":
      return { text: `Verification could not complete${str(d.message) ? `: ${d.message}` : ""}`, tone: "warn", refs };
    case "FUNDS_CAPTURED":
      return { text: `PayPal captured${amount ? ` ${amount}` : " the hold"} from the payer`, tone: "money", refs };
    case "PAYOUT_SENT":
      return {
        text: `Payout${amount ? ` of ${amount}` : ""} sent to ${str(d.receiver) ?? "the worker"}${str(d.batch_status) ? ` (PayPal: ${d.batch_status})` : ""}`,
        tone: "money",
        refs,
      };
    case "AUTHORIZATION_VOIDED":
      return { text: "Hold released. The payer was not charged", tone: "warn", refs };
    case "REFUND_SENT":
      return { text: `${amount ?? "Money"} refunded to the payer`, tone: "warn", refs };
    case "ACTION_FAILED":
      // A failed funding step keeps PayPal's raw error on the stored event (the API returns it); the tape says what it means.
      if (d.action === "fund" && d.error === "PayPalError") {
        const what = step === "create_order" ? "PayPal did not create the order" : step === "authorize" ? "PayPal did not place the hold" : "PayPal refused the request";
        return { text: `Funding did not complete: ${what}`, tone: "fail", refs };
      }
      {
        const message = str(d.message);
        const shown = message && /\bPayPal (?:GET|POST|PUT|PATCH|DELETE) \S+ failed: HTTP \d+/.test(message) ? "PayPal refused the request" : message;
        return { text: `${step ? humanize(step) : "A step"} failed${shown ? `: ${shown}` : ""}`, tone: "fail", refs };
      }
    case "DISPUTE_OPENED":
      return { text: `${actorLabel(d.actor).label} contested the result`, tone: "warn", refs };
    case "DISPUTE_ARGUMENT_ADDED":
      return { text: `${actorLabel(d.actor).label} stated their side`, tone: "warn", refs };
    case "DISPUTE_PROPOSED":
      return {
        text: `Mediator proposed a split${typeof d.proposed_worker_cents === "number" ? `: ${formatCents(d.proposed_worker_cents, currency)} to the worker` : ""}`,
        tone: "info",
        refs,
      };
    case "DISPUTE_ACCEPTED":
      return { text: `${actorLabel(d.actor).label} accepted the split`, tone: "pass", refs };
    case "DISPUTE_DECLINED":
      return { text: `${actorLabel(d.actor).label} declined the split. A person will decide`, tone: "warn", refs };
    case "PAYOUT_STATUS": {
      const status = str(d.status)?.toUpperCase() ?? null;
      if (status === "SUCCESS") return { text: "PayPal confirmed the payout reached the worker", tone: "money", refs };
      return {
        text: `PayPal reports the payout as ${status ? status.toLowerCase() : "updated"}`,
        tone: status && ["UNCLAIMED", "FAILED", "RETURNED", "BLOCKED", "DENIED"].includes(status) ? "warn" : "info",
        refs,
      };
    }
    case "DRAFTER_NOTES": {
      const n = Array.isArray(d.notes) ? d.notes.length : 0;
      return { text: `The AI recorded ${n === 1 ? "a note" : `${n || ""} notes`.trim()} on how it read the deal`, tone: "info", refs };
    }
    case "PAYPAL_WEBHOOK":
      return { text: `PayPal notified Treuhand${str(d.event_type) ? `: ${d.event_type}` : ""}`, tone: "money", refs };
    case "GITHUB_COMMENT_POSTED": {
      const href = githubCommentUrl(d.comment_url);
      return {
        text: `Verdict ${d.action === "updated" ? "updated" : "posted"} on the pull request`,
        tone: "info",
        refs,
        ...(href ? { link: { href, label: "View the comment" } } : {}),
      };
    }
    case "GITHUB_COMMENT_FAILED":
      return { text: `Verdict not posted on the pull request${str(d.reason) ? `: ${d.reason}` : ""}`, tone: "warn", refs };
    default:
      return { text: humanize(e.kind), tone: "neutral", refs };
  }
}

/** A failed step retried by the sweep logs the same failure again and again; only PayPal's debug id differs. */
function retryKey(e: ClauseEvent): string | null {
  if (e.kind !== "ACTION_FAILED") return null;
  const message = str(e.detail.message)?.replace(/\s*\[debug_id[^\]]*\]/gi, "") ?? "";
  return `${String(e.detail.action)}|${String(e.detail.step)}|${message}`;
}

/** Newest first, with runs of the same repeated failure folded into one entry. */
function collapse(events: ClauseEvent[]): { event: ClauseEvent; repeats: number; firstAt: string }[] {
  const out: { event: ClauseEvent; repeats: number; firstAt: string }[] = [];
  for (const e of [...events].reverse()) {
    const prev = out[out.length - 1];
    const key = retryKey(e);
    if (prev && key !== null && retryKey(prev.event) === key) {
      prev.repeats++;
      prev.firstAt = e.created_at;
      continue;
    }
    out.push({ event: e, repeats: 1, firstAt: e.created_at });
  }
  return out;
}

export function AuditTrail({ events, currency }: { events: ClauseEvent[]; currency: string }) {
  const ordered = collapse(events);
  if (ordered.length === 0) return <p className="px-4 py-4 text-sm text-ink-3">Nothing has happened yet.</p>;
  return (
    <div>
      <div
        aria-hidden
        className="sticky top-0 z-10 hidden grid-cols-[9.25rem_5.25rem_minmax(0,1fr)] gap-x-3 border-b border-rule bg-surface-2 px-4 py-1.5 sm:grid"
      >
        <span className="label">Time</span>
        <span className="label">Actor</span>
        <span className="label">Event</span>
      </div>
      <ol>
        {ordered.map(({ event: e, repeats, firstAt }, i) => {
          const line = describe(e, currency);
          const actor = e.detail.actor ? actorLabel(e.detail.actor) : null;
          return (
            <li
              key={e.id}
              className={cx(
                "grid grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-0.5 border-b border-rule/70 px-4 py-2 last:border-b-0 sm:grid-cols-[9.25rem_5.25rem_minmax(0,1fr)] sm:items-baseline",
                i === 0 && "rise",
              )}
            >
              <span className="flex items-baseline gap-3 sm:contents">
                <TapeTime iso={e.created_at} className="tnum text-[0.7rem] whitespace-nowrap text-ink-3" />
                <span className={cx("font-semibold text-[0.7rem]  ", actor ? TONE_TEXT[actor.tone] : "text-ink-3")}>
                  {actor ? actor.label : "—"}
                </span>
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className={cx("size-1.5 shrink-0 translate-y-[-1px] rounded-[1px]", TONE_DOT[line.tone])} aria-hidden />
                  {line.state ? (
                    <span className="flex items-center gap-1.5 text-[0.8125rem] text-ink-2">
                      Now <StateChip state={line.state} />
                    </span>
                  ) : (
                    <p className="min-w-0 text-[0.8125rem] leading-snug break-words text-ink">
                      {line.text}
                      {line.link ? (
                        <>
                          {" "}
                          <a href={line.link.href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                            {line.link.label}
                          </a>
                        </>
                      ) : null}
                    </p>
                  )}
                </div>
                {repeats > 1 || line.refs.length > 0 ? (
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-3.5 tnum text-[0.66rem] text-ink-3">
                    {repeats > 1 ? (
                      <span className="font-semibold text-disputed">
                        {repeats} attempts since <LocalTime iso={firstAt} />
                      </span>
                    ) : null}
                    {line.refs.map(([label, value]) => (
                      <span key={label} className="min-w-0 truncate">
                        {label.toLowerCase()} <span className="font-code text-ink-2">{value}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
