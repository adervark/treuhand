/**
 * The dispute as both parties see it: each side's argument, the mediator's
 * proposed split with its reasoning, and who has accepted. Read-only; the
 * viewer's own controls are in "Your move".
 */
import type { Contract, Dispute, Party } from "@/lib/types";
import { formatCents } from "../format";
import { IconCheck, IconScale, IconX } from "../icons";
import { RoleMark } from "../role-mark";
import { Card, CardHeader, Chip, cx } from "../ui";

const DISPUTE_CHIP: Record<Dispute["state"], { label: string; tone: "disputed" | "machine" | "paid" }> = {
  OPEN: { label: "Waiting for both sides", tone: "disputed" },
  PROPOSED: { label: "Split proposed", tone: "machine" },
  SETTLED: { label: "Settled", tone: "paid" },
  ESCALATED: { label: "With a human", tone: "disputed" },
};

export function DisputeCard({ contract, dispute }: { contract: Contract; dispute: Dispute }) {
  const meta = DISPUTE_CHIP[dispute.state];
  const fmt = (c: number) => formatCents(c, contract.currency);
  const worker = dispute.proposed_worker_cents;
  const payer = worker === null ? null : contract.amount_cents - worker;
  const workerPct = worker === null ? 0 : Math.round((worker / contract.amount_cents) * 100);

  return (
    <Card className="overflow-hidden border-disputed/50">
      <CardHeader
        className="bg-disputed-soft"
        eyebrow={<span className="flex items-center gap-1.5 text-disputed"><IconScale size={13} /> Dispute</span>}
        title={`Contested by the ${dispute.opened_by}`}
        aside={<Chip tone={meta.tone} dot>{meta.label}</Chip>}
      />
      <div className="grid gap-3 px-4 py-3.5 sm:grid-cols-2">
        <Argument party="payer" text={dispute.payer_argument} />
        <Argument party="worker" text={dispute.worker_argument} />
      </div>

      {worker !== null && payer !== null ? (
        <div className="border-t border-rule px-4 py-3.5">
          <p className="label flex items-center gap-1.5">
            Mediator&apos;s proposal
          </p>
          <div className="mt-2 flex items-baseline justify-between gap-3 text-[0.8125rem]">
            <span className="flex items-baseline gap-1.5">
              <span className="tnum text-[1.05rem] font-semibold text-ink">{fmt(worker)}</span>{" "}
              <span className="inline-flex items-center gap-1 text-ink-3">
                <span className="size-2 bg-worker-fill" aria-hidden />
                to the worker
              </span>
            </span>
            <span className="flex items-baseline gap-1.5 text-right">
              <span className="tnum text-[1.05rem] font-semibold text-ink">{fmt(payer)}</span>{" "}
              <span className="inline-flex items-center gap-1 text-ink-3">
                <span className="size-2 bg-payer-fill" aria-hidden />
                back to the payer
              </span>
            </span>
          </div>
          <div className="mt-2 flex h-2.5 gap-0.5 overflow-hidden rounded-xs" role="img" aria-label={`${workerPct}% to the worker, ${100 - workerPct}% to the payer`}>
            <span className="bg-worker-fill" style={{ width: `${workerPct}%` }} />
            <span className="flex-1 bg-payer-fill" />
          </div>
          <div className="mt-1 flex justify-between tnum text-[0.66rem] text-ink-3">
            <span>{workerPct}%</span>
            <span>{100 - workerPct}%</span>
          </div>
          {dispute.proposal_reasoning ? (
            <p className="mt-2.5 max-w-[88ch] tnum text-[0.75rem] leading-[1.25rem] text-ink-2">{dispute.proposal_reasoning}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Acceptance party="payer" value={dispute.payer_accepted} />
            <Acceptance party="worker" value={dispute.worker_accepted} />
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function Argument({ party, text }: { party: Party; text: string | null }) {
  return (
    <div className={cx("border border-rule bg-surface-2 px-3.5 py-3", party === "payer" ? "shadow-[inset_3px_0_0_var(--payer)]" : "shadow-[inset_3px_0_0_var(--worker)]")}>
      <p className={cx("label flex items-center gap-1.5", party === "payer" ? "text-payer" : "text-worker")}>
        <RoleMark role={party} />
        {party === "payer" ? "Payer's side" : "Worker's side"}
      </p>
      {text ? (
        <p className="mt-1 text-[0.85rem] leading-relaxed whitespace-pre-wrap text-ink">{text}</p>
      ) : (
        <p className="mt-1 text-[0.85rem] text-ink-3">Not stated yet.</p>
      )}
    </div>
  );
}

function Acceptance({ party, value }: { party: Party; value: boolean | null }) {
  const name = party === "payer" ? "Payer" : "Worker";
  if (value === true)
    return (
      <Chip tone="paid">
        <IconCheck size={12} strokeWidth={2.6} /> {name} accepted
      </Chip>
    );
  if (value === false)
    return (
      <Chip tone="fail">
        <IconX size={12} strokeWidth={2.6} /> {name} declined
      </Chip>
    );
  return <Chip tone="neutral">{name} has not answered</Chip>;
}
