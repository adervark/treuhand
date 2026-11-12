"use client";

/**
 * "Your move": what the current viewer can do right now. Every control here
 * is shown only when its action is in the API's `allowed_actions`; the page
 * holds no rules of its own about who may do what.
 */
import { useId, useState, type ReactNode } from "react";
import type { Contract, Dispute, Identity, Party } from "@/lib/types";
import { api, type AllowedAction, type ContractBundle } from "../api";
import { formatCents } from "../format";
import { IconCheck, IconPen, IconRefresh, IconScale } from "../icons";
import { LocalTime, RelativeTime, useNow } from "../time";
import { RoleMark } from "../role-mark";
import { Banner, Button, cx, inputClass, Spinner } from "../ui";
import { contractNotice } from "./money";
import { PayPalButton } from "./paypal-button";

export type Run = (key: string, fn: () => Promise<unknown>) => Promise<boolean>;

export interface ActionState {
  pending: string | null;
  failure: { key: string; message: string } | null;
}

const ROLE_NAME: Record<Party, string> = { payer: "Payer", worker: "Worker" };

const IN_PROGRESS: Record<string, string> = {
  fund: "Placing the PayPal hold…",
  submit: "Recording the submission…",
  verify: "The verifier is checking the work. Nobody needs to press anything.",
  settle_pass: "Every test passed. Capturing the hold and paying the worker…",
  expire: "Releasing the hold…",
  mediate: "The mediator is reading both sides…",
  settle_split: "Paying out the agreed split…",
};

/** In progress again after the last attempt of the same action failed: a retry, not a payment under way. */
const RETRYING: Record<string, string> = {
  settle_pass: "Trying the payment to the worker again…",
  expire: "Trying again to release the hold…",
  settle_split: "Trying the settlement of the split again…",
};

function waitingCopy(contract: Contract, role: Party, dispute: Dispute | null): string {
  const other = role === "payer" ? "worker" : "payer";
  switch (contract.state) {
    case "DRAFT": {
      const mine = role === "payer" ? contract.payer_signed_at : contract.worker_signed_at;
      return mine ? `You signed. Waiting for the ${other} to sign.` : "Review the terms and the tests.";
    }
    case "SIGNED":
      return role === "worker" ? "Both signed. Waiting for the payer to fund it with PayPal." : "Both signed.";
    case "FUNDED":
      return role === "payer"
        ? "PayPal is holding the money. Waiting for the worker to deliver."
        : "PayPal is holding the money for you.";
    case "SUBMITTED":
    case "VERIFYING":
      return "The verifier is checking the work. Nobody needs to press anything.";
    case "PASSED":
      return "Every test passed. PayPal pays the worker automatically.";
    case "FAILED":
      return role === "payer" ? "A test failed. Waiting for the worker to fix it and resubmit." : "A test failed.";
    case "PAID":
      return "Done. Every test passed and PayPal paid the worker.";
    case "EXPIRED":
      return "The deadline passed without a pass. The hold was released; the payer was not charged.";
    case "DISPUTED":
      if (dispute?.state === "PROPOSED") return `Waiting for the ${other} to answer the mediator's proposal.`;
      return `Waiting for the ${other} to state their side.`;
    case "SETTLED":
      return dispute ? "Settled by the agreed split." : "PayPal returned the payout 3 times, so the payer was refunded in full.";
    case "ESCALATED":
      return "The parties did not agree on the split. A person at Proviso decides.";
  }
}

export function YourMove({
  bundle,
  role,
  identities,
  run,
  state,
  editing,
  onEdit,
  reload,
}: {
  bundle: ContractBundle;
  role: Party;
  identities: Identity[];
  run: Run;
  state: ActionState;
  editing: boolean;
  onEdit: (on: boolean) => void;
  reload: () => void;
}) {
  const { contract, dispute, activity, verification } = bundle;
  const allowed = new Set<AllowedAction>(bundle.allowed_actions);
  const me = identities.find((i) => i.role === role);
  const has = (a: AllowedAction) => allowed.has(a);
  // Editing the tests and contesting are side doors; without a main action the viewer is told what they are waiting for.
  const anyMainAction = bundle.allowed_actions.some((a) => a !== "edit_conditions" && a !== "dispute");
  const failureFor = (key: string) => (state.failure?.key === key ? state.failure.message : null);
  // A failed money step, an agreed split or a passed deadline is said instead of the waiting copy.
  const notice = contractNotice(bundle, useNow());

  return (
    <section
      aria-labelledby="your-move-title"
      className={cx(
        "overflow-hidden border border-rule bg-surface",
        role === "payer" ? "shadow-[inset_0_2px_0_var(--payer-fill)]" : "shadow-[inset_0_2px_0_var(--worker-fill)]",
      )}
    >
      <header
        className={cx(
          "flex items-center justify-between gap-3 border-b border-rule bg-head px-3 pt-2 pb-1.5 text-ink",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <RoleMark role={role} size="md" />
          <div className="min-w-0">
            <p className="panel-title">
              Your move · {ROLE_NAME[role]}
            </p>
            <h2 id="your-move-title" className="truncate text-[0.875rem] leading-5 font-semibold">
              {me ? (
                <>
                  {me.display_name} <span className="text-[0.72rem] font-normal text-ink-2">{me.email}</span>
                </>
              ) : (
                ROLE_NAME[role]
              )}
            </h2>
          </div>
        </div>
        {activity.in_progress ? <Spinner /> : null}
      </header>

      <div className="flex flex-col gap-3.5 px-4 py-3.5">
        {activity.in_progress ? (
          <p className="flex items-center gap-2 text-[0.8125rem] font-semibold text-machine" role="status">
            <span className="pulse-dot size-2 shrink-0 rounded-[1px] bg-machine-fill" aria-hidden />
            {(activity.last_failure?.action === activity.in_progress ? RETRYING[activity.in_progress] : null) ??
              IN_PROGRESS[activity.in_progress] ??
              "Working…"}
          </p>
        ) : null}

        {contract.state === "DRAFT" ? <SignOffs contract={contract} identities={identities} /> : null}

        {!activity.in_progress && (notice || !anyMainAction) ? (
          <p className="text-[0.875rem] leading-snug text-ink">{notice?.text ?? waitingCopy(contract, role, dispute)}</p>
        ) : null}

        {has("sign") ? (
          <ActionBlock error={failureFor("sign")}>
            <p className="text-[0.8125rem] leading-snug text-ink-2">
              Signing agrees to every term and test as written. Any later edit clears both signatures.
            </p>
            <Button
              variant={role}
              size="lg"
              className="w-full"
              busy={state.pending === "sign"}
              onClick={() => run("sign", () => postJson(`/api/contracts/${contract.id}/sign`))}
            >
              <IconPen size={16} /> Sign as {ROLE_NAME[role].toLowerCase()}
            </Button>
          </ActionBlock>
        ) : null}

        {has("edit_conditions") && !editing ? (
          <Button variant="secondary" size="sm" className="self-start" onClick={() => onEdit(true)}>
            Edit the tests
          </Button>
        ) : null}

        {has("fund") ? (
          <ActionBlock error={null}>
            <p className="text-[0.8125rem] leading-snug text-ink-2">
              Fund it with PayPal. <span className="tnum font-semibold text-held">{formatCents(contract.amount_cents, contract.currency)}</span> is
              held on your account, not charged, until every test passes.
            </p>
            <PayPalButton contractId={contract.id} currency={contract.currency} onFunded={reload} />
          </ActionBlock>
        ) : null}

        {has("submit") ? (
          <SubmitWork contract={contract} run={run} pending={state.pending === "submit"} error={failureFor("submit")} resubmit={contract.state === "FAILED"} />
        ) : null}

        {has("rerun_verification") ? (
          <ActionBlock error={failureFor("rerun")}>
            <p className="text-[0.8125rem] leading-snug text-ink-2">
              {verification?.message ?? (verification?.status === "error" ? "The verification run crashed." : "A check could not complete.")}{" "}
              Nothing was decided and no money moved. Run the checks again.
            </p>
            <Button
              variant="secondary"
              className="w-full"
              busy={state.pending === "rerun"}
              onClick={() => run("rerun", () => postJson(`/api/contracts/${contract.id}/verify`))}
            >
              <IconRefresh size={16} /> Re-run the checks
            </Button>
          </ActionBlock>
        ) : null}

        {has("respond") && dispute ? (
          <ArgueForm
            key={`respond-${dispute.id}`}
            title={(role === "payer" ? dispute.payer_argument : dispute.worker_argument) ? "Revise your side" : "State your side"}
            hint="The mediator reads the contract, the evidence and both sides, then proposes a split."
            submitLabel="Send to the mediator"
            pendingNote="The mediator is reading the contract, the evidence and both sides. This takes up to a minute."
            pending={state.pending === "respond"}
            error={failureFor("respond")}
            onSubmit={(argument) => run("respond", () => postJson(`/api/contracts/${contract.id}/dispute/respond`, { argument }))}
          />
        ) : null}

        {(has("accept") || has("decline")) && dispute ? (
          <AnswerProposal
            contract={contract}
            dispute={dispute}
            canAccept={has("accept")}
            canDecline={has("decline")}
            run={run}
            pending={state.pending}
            error={failureFor("accept") ?? failureFor("decline")}
          />
        ) : null}

        {has("dispute") ? (
          <OpenDispute contract={contract} run={run} pending={state.pending === "dispute"} error={failureFor("dispute")} />
        ) : null}
      </div>
    </section>
  );
}

function postJson(path: string, body?: unknown): Promise<unknown> {
  return api(path, { method: "POST", body });
}

function ActionBlock({ error, children }: { error: string | null; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      {children}
      {error ? <Banner title="That did not go through">{error}</Banner> : null}
    </div>
  );
}

function SignOffs({ contract, identities }: { contract: Contract; identities: Identity[] }) {
  const rows: [Party, string | null][] = [
    ["payer", contract.payer_signed_at],
    ["worker", contract.worker_signed_at],
  ];
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Sign-offs">
      {rows.map(([party, at]) => {
        const who = identities.find((i) => i.role === party)?.display_name ?? ROLE_NAME[party];
        return (
          <li key={party} className="flex items-center justify-between gap-2 rounded-sm bg-surface-2 px-3 py-2 ring-1 ring-rule ring-inset">
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <RoleMark role={party} />
              <span className="font-semibold text-ink">{ROLE_NAME[party]}</span>
              <span className="truncate text-ink-3">{who}</span>
            </span>
            {at ? (
              <span className="flex shrink-0 items-center gap-1 tnum text-[0.7rem] font-semibold text-paid">
                <IconCheck size={13} strokeWidth={2.8} /> Signed <RelativeTime iso={at} className="font-normal text-ink-3 normal-case" />
              </span>
            ) : (
              <span className="shrink-0 tnum text-[0.7rem] text-ink-3">Not signed</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SubmitWork({
  contract,
  run,
  pending,
  error,
  resubmit,
}: {
  contract: Contract;
  run: Run;
  pending: boolean;
  error: string | null;
  resubmit: boolean;
}) {
  const id = useId();
  const [url, setUrl] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const placeholder = contract.type === "code_bounty" ? "https://github.com/owner/repo/pull/123" : "https://your-site.example.com";

  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const value = url.trim();
        if (!/^https?:\/\/\S+$/i.test(value)) {
          setInvalid("Enter the full link, starting with https://");
          return;
        }
        setInvalid(null);
        const ok = await run("submit", () => postJson(`/api/contracts/${contract.id}/submit`, { url: value }));
        if (ok) setUrl("");
      }}
    >
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {resubmit ? "Fixed it? Submit the work again" : contract.type === "code_bounty" ? "Link to the pull request" : "Link to the live site"}
      </label>
      <input
        id={id}
        type="url"
        inputMode="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={`${id}-hint`}
        className={cx(inputClass, "tnum text-[0.78rem]")}
        required
      />
      <p id={`${id}-hint`} className={cx("text-xs", invalid ? "font-medium text-fail" : "text-ink-3")}>
        {invalid ?? "The verifier opens this link itself and checks every test. It treats the page as content, never as instructions."}
      </p>
      <Button type="submit" variant="worker" size="lg" className="w-full" busy={pending}>
        {resubmit ? "Resubmit for checking" : "Submit for checking"}
      </Button>
      {error ? <Banner title="Submission not accepted">{error}</Banner> : null}
    </form>
  );
}

function ArgueForm({
  title,
  hint,
  submitLabel,
  pending,
  pendingNote,
  error,
  onSubmit,
  onCancel,
}: {
  title: string;
  hint: string;
  submitLabel: string;
  pending: boolean;
  /** Shown under the button while the request runs. */
  pendingNote?: string;
  error: string | null;
  onSubmit: (argument: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        const ok = await onSubmit(text.trim());
        if (ok) setText("");
      }}
    >
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        {title}
      </label>
      <textarea
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={4000}
        required
        aria-describedby={`${id}-hint`}
        placeholder="What happened, and what you think is fair."
        className={cx(inputClass, "field-sizing-content min-h-20 resize-none")}
      />
      <p id={`${id}-hint`} className="text-xs text-ink-3">
        {hint}
      </p>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" className="flex-1" busy={pending} disabled={!text.trim()}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
      </div>
      {pending && pendingNote ? (
        <p className="flex items-center gap-2 text-[0.8rem] font-medium text-machine" role="status">
          <span className="pulse-dot size-1.5 rounded-[1px] bg-machine-fill" aria-hidden /> {pendingNote}
        </p>
      ) : null}
      {error ? <Banner title="Not sent">{error}</Banner> : null}
    </form>
  );
}

function OpenDispute({ contract, run, pending, error }: { contract: Contract; run: Run; pending: boolean; error: string | null }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="border-t border-rule pt-3">
        <Button variant="ghost" size="sm" className="!px-0 text-ink-2 hover:!bg-transparent hover:text-disputed" onClick={() => setOpen(true)}>
          <IconScale size={16} /> Contest this and ask the mediator
        </Button>
      </div>
    );
  }
  return (
    <div className="border-t border-rule pt-3">
      <ArgueForm
        title="Contest the result"
        hint="The other party states their side, then the mediator proposes a split. Nothing moves until both accept."
        submitLabel="Open a dispute"
        pending={pending}
        error={error}
        onCancel={() => setOpen(false)}
        onSubmit={(argument) => run("dispute", () => postJson(`/api/contracts/${contract.id}/dispute`, { argument }))}
      />
    </div>
  );
}

function AnswerProposal({
  contract,
  dispute,
  canAccept,
  canDecline,
  run,
  pending,
  error,
}: {
  contract: Contract;
  dispute: Dispute;
  canAccept: boolean;
  canDecline: boolean;
  run: Run;
  pending: string | null;
  error: string | null;
}) {
  const worker = dispute.proposed_worker_cents ?? 0;
  const payer = contract.amount_cents - worker;
  const fmt = (c: number) => formatCents(c, contract.currency);
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-[0.8125rem] leading-snug text-ink-2">
        The mediator proposes <strong className="tnum font-semibold text-ink">{fmt(worker)}</strong> to the worker and{" "}
        <strong className="tnum font-semibold text-ink">{fmt(payer)}</strong> back to the payer. When both accept, PayPal pays it out at once.
      </p>
      <div className="flex gap-2">
        {canAccept ? (
          <Button
            variant="money"
            className="flex-1"
            busy={pending === "accept"}
            disabled={pending === "decline"}
            onClick={() => run("accept", () => postJson(`/api/contracts/${contract.id}/dispute/accept`))}
          >
            <IconCheck size={16} strokeWidth={2.4} /> Accept the split
          </Button>
        ) : null}
        {canDecline ? (
          <Button
            variant="danger"
            busy={pending === "decline"}
            disabled={pending === "accept"}
            onClick={() => run("decline", () => postJson(`/api/contracts/${contract.id}/dispute/accept`, { accept: false }))}
          >
            Decline
          </Button>
        ) : null}
      </div>
      {canDecline ? <p className="text-xs text-ink-3">Declining sends the case to a person at Proviso.</p> : null}
      {error ? <Banner title="Not recorded">{error}</Banner> : null}
      <p className="text-xs text-ink-3">
        Proposed <LocalTime iso={dispute.updated_at} />
      </p>
    </div>
  );
}
