/**
 * TEST-ONLY helpers for an end-to-end run of the contract flow over HTTP. Not part of
 * the app: nothing under src/ imports this file and Next.js never serves it.
 * It refuses to touch the real database (data/clause.db): point CLAUSE_DB_PATH
 * at a separate file, the same one the dev server under test was started with.
 *
 *   CLAUSE_DB_PATH=/tmp/e2e.db pnpm exec tsx --env-file=.env scripts/flow-e2e.ts order <orderId>
 *       Reads a PayPal sandbox order (read-only) and prints its status and approve link.
 *
 *   CLAUSE_DB_PATH=/tmp/e2e.db pnpm exec tsx scripts/flow-e2e.ts fund <contractId>
 *       Moves a SIGNED contract to FUNDED by writing the rows directly, because
 *       approving a sandbox order needs a buyer login. NO MONEY IS HELD: the
 *       authorization id is made up ("TEST-ONLY-AUTH-..."), so any later
 *       capture or void sent to PayPal for it fails with 404, as it should.
 *
 *   CLAUSE_DB_PATH=/tmp/e2e.db pnpm exec tsx --env-file=.env scripts/flow-e2e.ts submit-fixture <contractId> [page]
 *       Submits http://127.0.0.1:<port>/<page> (test/fixtures/site, default good.html)
 *       as the worker and runs verification in THIS process with the
 *       verifier's test-only private-network flag on. The app's own verifier
 *       refuses loopback addresses (correctly), so this is the only way to
 *       verify the local fixture site. Poll GET /api/contracts/<id> meanwhile.
 *       Evidence is written under ./data/evidence of the working directory.
 */
import path from "node:path";
import { submitWork } from "@/lib/contract/service";
import { transition } from "@/lib/contract/machine";
import { getContract } from "@/lib/db/contracts";
import { recordEvent } from "@/lib/db/events";
import { getDb } from "@/lib/db/index";
import { recordLedgerEntry } from "@/lib/db/ledger";
import { PAYPAL_API_BASE } from "@/lib/env";
import { getAccessToken } from "@/lib/paypal";
import { unsafeAllowPrivateNetworkForTests } from "@/lib/verifier/net-guard";
import { startFixtureServer } from "../test/fixtures/server";

const SOURCE = "scripts/flow-e2e.ts (TEST ONLY: no PayPal hold exists)";

function requireSeparateDb(): void {
  const target = process.env.CLAUSE_DB_PATH;
  const real = path.join(process.cwd(), "data", "clause.db");
  if (!target || target === ":memory:" || path.resolve(target) === path.resolve(real)) {
    console.error("Set CLAUSE_DB_PATH to the separate database the dev server under test uses. This script never writes data/clause.db.");
    process.exit(1);
  }
}

async function showOrder(orderId: string): Promise<void> {
  const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${await getAccessToken()}`, Accept: "application/json" },
  });
  const body = (await res.json()) as {
    status?: string;
    intent?: string;
    purchase_units?: { reference_id?: string; custom_id?: string; amount?: { currency_code: string; value: string } }[];
    links?: { rel: string; href: string }[];
  };
  const unit = body.purchase_units?.[0];
  console.log(
    JSON.stringify(
      {
        http: res.status,
        status: body.status,
        intent: body.intent,
        reference_id: unit?.reference_id,
        custom_id: unit?.custom_id,
        amount: unit?.amount,
        approve: body.links?.find((l) => l.rel === "approve" || l.rel === "payer-action")?.href ?? null,
      },
      null,
      2,
    ),
  );
}

function fundForTest(contractId: string): void {
  const authorizationId = `TEST-ONLY-AUTH-${contractId.slice(0, 8)}`;
  const contract = getDb()
    .transaction(() => {
      const current = getContract(contractId);
      if (!current) throw new Error(`no contract ${contractId}`);
      const funded = transition(contractId, "FUNDED", {
        actor: "payer",
        paypal: { paypal_authorization_id: authorizationId },
        detail: { source: SOURCE },
      });
      recordLedgerEntry({
        contract_id: contractId,
        kind: "AUTHORIZED",
        amount_cents: funded.amount_cents,
        paypal_ref: authorizationId,
        raw: { test_only: true, source: SOURCE },
      });
      recordEvent({
        contract_id: contractId,
        kind: "FUNDS_AUTHORIZED",
        detail: { actor: "payer", authorization_id: authorizationId, amount_cents: funded.amount_cents, test_only: true, source: SOURCE },
      });
      return funded;
    })
    .immediate();
  console.log(JSON.stringify({ id: contract.id, state: contract.state, paypal_authorization_id: contract.paypal_authorization_id }));
}

async function submitFixture(contractId: string, page: string): Promise<void> {
  unsafeAllowPrivateNetworkForTests(true);
  const server = await startFixtureServer();
  try {
    const url = `${server.url}/${page}`;
    const job = submitWork(contractId, "worker", url);
    console.log(JSON.stringify({ submitted: url, submissionId: job.submissionId, state: getContract(contractId)?.state }));
    const started = Date.now();
    await job.run();
    console.log(
      JSON.stringify({
        done_in_s: Math.round((Date.now() - started) / 1000),
        state: getContract(contractId)?.state,
        fixture_requests: server.requests,
      }),
    );
  } finally {
    await server.close();
    unsafeAllowPrivateNetworkForTests(false);
  }
}

async function main(): Promise<void> {
  const [command, arg, extra] = process.argv.slice(2);
  requireSeparateDb();
  if (command === "order" && arg) return showOrder(arg);
  if (command === "fund" && arg) return fundForTest(arg);
  if (command === "submit-fixture" && arg) return submitFixture(arg, extra ?? "good.html");
  console.error("usage: flow-e2e.ts order <orderId> | fund <contractId> | submit-fixture <contractId> [page]");
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
