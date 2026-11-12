/**
 * Disputes: open, argue (the mediator proposes once both sides have argued),
 * accept or decline. When both accept, the split is settled through
 * `settleSplit` (service-money.ts).
 */
import { proposeSplit } from "@/lib/ai/mediator";
import { listConditions } from "@/lib/db/conditions";
import { getContract } from "@/lib/db/contracts";
import { createDispute, getActiveDispute, getDispute, updateDispute } from "@/lib/db/disputes";
import { recordEvent } from "@/lib/db/events";
import { getDb } from "@/lib/db/index";
import { getLatestSubmission } from "@/lib/db/submissions";
import { listVerdictsForSubmission } from "@/lib/db/verdicts";
import { MissingEnvError } from "@/lib/env";
import type { Contract, Dispute, Party } from "@/lib/types";
import { ContractNotFoundError, transition } from "./machine";
import { assertUnclaimed, withClaim } from "./service-claims";
import { errorMessage, ServiceError, throwIfDenied } from "./service-errors";
import { recordFailure, settleSplit } from "./service-money";
import { acceptDenial, argueDenial, declineDenial, isSplitAgreed, openDisputeDenial } from "./service-rules";

function inTx<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate();
}

function loadContract(contractId: string): Contract {
  const contract = getContract(contractId);
  if (!contract) throw new ContractNotFoundError(contractId);
  return contract;
}

/** A dispute left OPEN or PROPOSED when the sweep expired its contract can no longer be argued or answered. */
function requireDisputed(contract: Contract): void {
  if (contract.state !== "DISPUTED") {
    throw new ServiceError("ILLEGAL_TRANSITION", `The contract is ${contract.state}; its dispute is closed.`);
  }
}

const argumentColumn = (party: Party) => (party === "payer" ? "payer_argument" : "worker_argument");
const acceptedColumn = (party: Party) => (party === "payer" ? "payer_accepted" : "worker_accepted");

/** Opens a dispute (either party) on a FUNDED, FAILED or PASSED contract. */
export function openDispute(contractId: string, party: Party, argument: string, now: Date = new Date()): Dispute {
  return inTx(() => {
    const contract = loadContract(contractId);
    assertUnclaimed(contractId, now);
    throwIfDenied(openDisputeDenial(contract));
    const dispute = createDispute({ contract_id: contractId, opened_by: party, [argumentColumn(party)]: argument });
    transition(contractId, "DISPUTED", { actor: party, detail: { dispute_id: dispute.id, from_state: contract.state } });
    recordEvent({ contract_id: contractId, kind: "DISPUTE_OPENED", detail: { actor: party, dispute_id: dispute.id } });
    return dispute;
  });
}

/**
 * Stores (or revises) the viewer's argument while the dispute is OPEN. Once
 * both arguments exist, asks the mediator for a split and moves the dispute to
 * PROPOSED. If the mediator fails the argument is kept and calling again retries.
 */
export async function respondToDispute(
  contractId: string,
  party: Party,
  argument: string,
  now: Date = new Date(),
): Promise<Dispute> {
  return withClaim(
    contractId,
    "mediate",
    (c) => {
      throwIfDenied(argueDenial(getActiveDispute(contractId)));
      requireDisputed(c);
    },
    async (contract) => {
      const dispute = inTx(() => {
        const current = getActiveDispute(contractId)!;
        const updated = updateDispute(current.id, { [argumentColumn(party)]: argument });
        recordEvent({ contract_id: contractId, kind: "DISPUTE_ARGUMENT_ADDED", detail: { actor: party, dispute_id: current.id } });
        return updated;
      });
      if (dispute.payer_argument === null || dispute.worker_argument === null) return dispute;
      return mediate(contract, dispute);
    },
    now,
  );
}

async function mediate(contract: Contract, dispute: Dispute): Promise<Dispute> {
  const latest = getLatestSubmission(contract.id);
  let proposal;
  try {
    proposal = await proposeSplit({
      contract,
      conditions: listConditions(contract.id),
      verdicts: latest ? listVerdictsForSubmission(latest.id) : [],
      payerArgument: dispute.payer_argument!,
      workerArgument: dispute.worker_argument!,
    });
  } catch (err) {
    recordFailure(contract.id, "mediate", "propose_split", err);
    if (err instanceof MissingEnvError) throw err;
    throw new ServiceError("AI_ERROR", `The mediator failed: ${errorMessage(err)}. Your argument was saved; try again.`, {
      cause: err,
    });
  }
  const cents = proposal.proposed_worker_cents;
  if (!Number.isInteger(cents) || cents < 0 || cents > contract.amount_cents) {
    const err = new Error(`mediator proposed ${cents} cents, outside 0..${contract.amount_cents}`);
    recordFailure(contract.id, "mediate", "validate_proposal", err);
    throw new ServiceError("AI_ERROR", `The mediator returned an invalid split (${err.message}). Try again.`);
  }
  return inTx(() => {
    const updated = updateDispute(dispute.id, {
      proposed_worker_cents: cents,
      proposal_reasoning: proposal.reasoning,
      payer_accepted: null,
      worker_accepted: null,
      state: "PROPOSED",
    });
    recordEvent({
      contract_id: contract.id,
      kind: "DISPUTE_PROPOSED",
      detail: {
        actor: "system",
        dispute_id: dispute.id,
        proposed_worker_cents: cents,
        refund_cents: contract.amount_cents - cents,
        reasoning: proposal.reasoning,
      },
    });
    return updated;
  });
}

export interface AcceptResult {
  dispute: Dispute;
  contract: Contract;
}

/**
 * Accepts (or, with `accept: false`, declines) the mediator's proposal. When
 * both have accepted, settles the split in the same call; a settlement already
 * running in another request is left to finish. Declining escalates the
 * dispute and the contract to ESCALATED for a human.
 */
export async function answerProposal(
  contractId: string,
  party: Party,
  accept: boolean,
  now: Date = new Date(),
): Promise<AcceptResult> {
  const dispute = inTx(() => {
    const contract = loadContract(contractId);
    assertUnclaimed(contractId, now);
    const current = getActiveDispute(contractId);
    if (!accept) {
      throwIfDenied(declineDenial(current, party));
      if (isSplitAgreed(current)) {
        throw new ServiceError("DISPUTE_STATE", "Both parties already accepted; the split is being settled.");
      }
      requireDisputed(contract);
      const declined = updateDispute(current!.id, { [acceptedColumn(party)]: false, state: "ESCALATED" });
      transition(contractId, "ESCALATED", { actor: party, detail: { dispute_id: current!.id } });
      recordEvent({ contract_id: contractId, kind: "DISPUTE_DECLINED", detail: { actor: party, dispute_id: current!.id } });
      return declined;
    }
    throwIfDenied(acceptDenial(current));
    requireDisputed(contract);
    if (current![acceptedColumn(party)] === true) return current!;
    const accepted = updateDispute(current!.id, { [acceptedColumn(party)]: true });
    recordEvent({ contract_id: contractId, kind: "DISPUTE_ACCEPTED", detail: { actor: party, dispute_id: current!.id } });
    return accepted;
  });

  if (accept && isSplitAgreed(dispute)) {
    try {
      await settleSplit(contractId, party, now);
    } catch (err) {
      if (!(err instanceof ServiceError && err.code === "BUSY")) throw err;
    }
  }
  return { dispute: getDispute(dispute.id)!, contract: loadContract(contractId) };
}
