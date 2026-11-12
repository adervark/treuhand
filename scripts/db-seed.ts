/**
 * Seeds the two demo identities and one sample DRAFT contract of each type.
 * Safe to rerun: identities are upserted, and a sample contract is skipped if
 * one with the same title already exists.
 *
 * The identities' emails come from DEMO_PAYER_EMAIL and DEMO_WORKER_EMAIL,
 * and seeding stops with an error if either is unset: payouts go to the
 * worker's email, so a made-up address would leave every payout UNCLAIMED.
 * `--placeholder-identities` seeds payer@example.com / worker@example.com
 * for any that is unset, for local runs where no money moves.
 */
import { closeDb, dbPath } from "@/lib/db";
import { createContract, listContracts } from "@/lib/db/contracts";
import { upsertIdentity } from "@/lib/db/identities";
import type { NewContractInput } from "@/lib/types";

const placeholders = process.argv.includes("--placeholder-identities");
const payerEmail = process.env.DEMO_PAYER_EMAIL?.trim() || (placeholders ? "payer@example.com" : "");
const workerEmail = process.env.DEMO_WORKER_EMAIL?.trim() || (placeholders ? "worker@example.com" : "");
if (!payerEmail || !workerEmail) {
  const missing = [!payerEmail && "DEMO_PAYER_EMAIL", !workerEmail && "DEMO_WORKER_EMAIL"].filter(Boolean);
  console.error(
    `db:seed: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set. Set both to the PayPal sandbox ` +
      "personal accounts of the demo payer and worker (payouts go to the worker's email), in .env or the " +
      "environment. For a local run where no money moves, pass --placeholder-identities to seed " +
      "payer@example.com and worker@example.com instead.",
  );
  process.exit(1);
}

const payer = upsertIdentity({ role: "payer", display_name: "Demo Payer", email: payerEmail });
const worker = upsertIdentity({ role: "worker", display_name: "Demo Worker", email: workerEmail });

// Three days: PayPal's honor period for an authorization, when a capture is
// most likely to succeed (the hold itself lasts up to 29 days; capture is
// never guaranteed).
const deadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

const samples: NewContractInput[] = [
  {
    title: "Sample bounty: fix issue #1",
    type: "code_bounty",
    payer_email: payer.email,
    worker_email: worker.email,
    amount_cents: 5000,
    currency: "USD",
    deadline_at: deadline,
    conditions: [
      {
        text: "The pull request is merged",
        check_kind: "github_pr_merged",
        check_params: { repo: "octocat/Hello-World" },
      },
      {
        text: "All checks pass on the pull request's head commit",
        check_kind: "github_checks_passed",
        check_params: { repo: "octocat/Hello-World" },
      },
      {
        text: "The pull request references issue #1",
        check_kind: "github_pr_references_issue",
        check_params: { repo: "octocat/Hello-World", issue: 1 },
      },
    ],
  },
  {
    title: "Sample website: bakery landing page",
    type: "website_milestone",
    payer_email: payer.email,
    worker_email: worker.email,
    amount_cents: 20000,
    currency: "USD",
    deadline_at: deadline,
    conditions: [
      { text: "The site loads at a public URL", check_kind: "http_ok", check_params: {} },
      {
        text: "The page works at phone width (375px) with no horizontal scrolling",
        check_kind: "responsive",
        check_params: { width: 375 },
      },
      {
        text: "The page has a contact form",
        check_kind: "dom_assert",
        check_params: { selector: "form" },
      },
      {
        text: "The contact form submits and shows a confirmation",
        check_kind: "form_submits",
        check_params: {
          form_selector: "form",
          fields: { "input[type=email]": "test@example.com" },
          success_text: "Thank you",
        },
      },
      {
        text: "The page clearly shows the bakery's opening hours",
        check_kind: "ai_page_judgement",
        check_params: { criterion: "Does the page clearly show the bakery's opening hours?" },
      },
    ],
  },
];

const existing = new Set(listContracts().map((c) => c.title));
for (const sample of samples) {
  if (existing.has(sample.title)) {
    console.log(`skip: "${sample.title}" already exists`);
    continue;
  }
  const contract = createContract(sample, "system");
  console.log(`created ${contract.type} contract ${contract.id}: "${contract.title}"`);
}
console.log(`seeded identities ${payer.email} (payer), ${worker.email} (worker) in ${dbPath()}`);
closeDb();
