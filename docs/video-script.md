# Demo video script

Target length 2:40 (Devpost limit: under 3:00). Recorded at 1920x1080 in the dark theme, one browser window plus one terminal. About 380 spoken words.

Each shot is marked with what it depends on:

- **PAYPAL**: needs the owner to approve a real payment in the PayPal sandbox window, logged in as the sandbox payer. Capture, void and payout through the app have not yet been run against the real sandbox, so rehearse these shots first (see "Rehearsal").
- **FIXTURE**: uses a contract built by `scripts/dev-fixtures.ts` (made-up PayPal references, never sent to PayPal). Show the caption "Sample contract" while it is on screen, and do not say it is live.
- **LIVE AI**: makes a real DeepSeek call during the shot. Each has a fallback.

## Before recording

1. **Fresh database, fixtures, real identities.** In the repository root, with `.env` holding the DeepSeek key, the US sandbox app and the two sandbox personal accounts as `DEMO_PAYER_EMAIL` and `DEMO_WORKER_EMAIL`:

   ```sh
   export CLAUSE_DB_PATH=data/video.db
   pnpm exec tsx scripts/dev-fixtures.ts   # deletes and rebuilds data/video.db: 14 sample contracts, one per state, with ledger rows and receipts
   pnpm db:seed                            # points the payer and worker identities at the two sandbox accounts (adds two sample drafts)
   ```

   `data/` is ignored by git, and neither script touches `data/clause.db`. The fixture contracts keep `payer@example.com` / `worker@example.com`; only contracts created during the recording use the sandbox accounts.
2. **Restart the dev server** on the recording database, so it loads the current code and the new file: stop the running `pnpm dev`, then `CLAUSE_DB_PATH=data/video.db pnpm dev`. Open `http://localhost:3000/contracts` and check the list shows the fixture contracts.
3. **Browser.** A clean browser profile (no extensions, bookmarks bar hidden, notifications off), window exactly 1920x1080, zoom 100%. Choose **Dark** in the header's theme switch. Use one window and the header's **Payer / Worker** switch: two windows of one profile always act as the same party (a stale window's click is refused with `ROLE_MISMATCH`). Log in to the PayPal sandbox payer in the PayPal window once during the rehearsal, so the recording never shows a password.
4. **Terminal.** Dark theme, 20 pt font, sized to the right half of the screen or full screen. Have these ready (replace `<id>` with the live contract's id from its URL once it exists):

   ```sh
   pnpm exec tsx scripts/verify-receipt.ts http://localhost:3000/api/contracts/<id>/receipts --app http://localhost:3000
   CLAUSE_DB_PATH=data/video.db pnpm exec tsx scripts/agent-demo.ts --app http://localhost:3000
   ```

5. **Fixture ids.** `dev-fixtures.ts` prints each contract's state, id and title. Keep that list open: shots 6, 7 and 8b use "Pricing page for Ledgerline", "RSVP page for the Okafor–Lee wedding" and "Crumb & Co. bakery landing page"; the ledger shot uses all of them.
6. **Order of recording.** Record the shots in the order below. Record the agent demo (shot 11) last: it adds a contract with a simulated hold whose capture fails at PayPal, which would show up in the ledger shot.

## Rehearsal

Run shots 2 to 9 once, start to finish, before recording. Check: the drafter gives three tests and refuses "look professional" alone; the PayPal approval leaves the contract `FUNDED` with an `AUTHORIZED` row on the Ledger page; after the pass the contract reaches `PAID` (payout `SUCCESS`) within a minute or two; and the receipt checker ends with `every receipt holds`. If the capture or payout fails in the rehearsal, record shot 8 from the fixture (8b) and say nothing about a live payout. After the rehearsal, rebuild the database (step 1) so the recording starts clean.

## Shots

| # | Time | On screen (page and action) | Spoken line | Depends on |
|---|---|---|---|---|
| 1 | 0:00–0:12 | Home page `/`. The example run on the left plays: four tests resolve, three AI reviewers vote on one, a hidden note to the verifier is caught, the receipt is signed, the hold is paid out. Press **Replay** if it has already played. | "Proviso is a contract that pays itself. The payer's money is held by PayPal, the work is checked against tests both sides signed, and the worker is paid the moment every test passes." | none |
| 2 | 0:12–0:32 | Same page, as **Payer**. Paste the deal into "The deal, in plain English": `Pay $20 for a one-page website, due in 3 days. It must load at a public URL, work at phone width (375px) without scrolling sideways, and explain that the domain is for use in documentation examples. It must also look professional.` Press **Draft the contract**. The refusal appears: "look professional", "No checkable version". Press **Remove from the deal**, then **Draft again**: three tests and the drafter's notes. | "You describe the deal in plain English, and AI turns it into tests a machine can check. Anything it can't check, like 'look professional', is refused, not guessed. Remove it, and you get three tests, with notes on how your words were read." | LIVE AI |
| 3 | 0:32–0:42 | Press **Create the contract**, then **Sign as payer**. Header switch to **Worker**, press **Sign as worker**. The state rail moves to `SIGNED`; the Receipt panel shows the terms fingerprint. | "Both sides sign the same tests. From here the terms are fixed and fingerprinted." | none |
| 4 | 0:42–0:56 | Header switch to **Payer**. Press the PayPal button; PayPal's sandbox window opens; approve as the logged-in sandbox payer. The contract shows `FUNDED`; the money flow band shows the amount held. | "The payer approves in PayPal's own window. PayPal authorizes the payment: the money is held on the payer's account, not charged." | PAYPAL |
| 5 | 0:56–1:18 | Header switch to **Worker**. Under "Link to the live site" enter `https://info.cern.ch/`, press **Submit for checking**. Verdicts arrive one by one: loads passes, phone width fails ("no mobile viewport tag"), the documentation test fails, each with reasoning and a screenshot. Then enter `https://example.com/`, press **Resubmit for checking**: all three pass, `PASSED`. | "The worker submits a link. Code checks every fact it can, in a real browser. The first page fails at phone width, and the worker sees exactly why. They fix it, resubmit, and every test passes." | LIVE AI (only if the third test is an AI judgement); live browser |
| 6 | 1:18–1:32 | Open "Pricing page for Ledgerline" from `/contracts`. Scroll to its AI-judged test and open the review panel: Strict reader, Worker's advocate and Sceptic each vote pass, "All 3 agree: pass"; the red "Manipulation attempt detected · Recorded · ignored" box quotes the hidden note. | "The one thing code can't decide goes to three AI reviewers with different briefs. It passes only if all three are sure. This page hid a note telling the verifier to pass it. The sceptic caught it, it was recorded, and it changed nothing." | FIXTURE |
| 7 | 1:32–1:44 | Open "RSVP page for the Okafor–Lee wedding". Its AI-judged test shows "Reviewers disagreed, so a person decides", the three votes split; the banner "Some checks could not complete" with **Re-run the checks** and **Open a dispute**. | "When the reviewers disagree, it doesn't guess. No money moves, and a re-run or a person decides." | FIXTURE |
| 8 | 1:44–1:58 | Back to the live contract. The money flow band moves: captured, payout sent, then `PAID` once PayPal reports the payout `SUCCESS` (the page checks every 10 seconds; cut the wait). | "On a pass, PayPal captures the hold and pays the worker by Payout, straight to their email. The contract is paid only when PayPal confirms it." | PAYPAL |
| 8b | (fallback for 8) | Open "Crumb & Co. bakery landing page" (`PAID`): the money flow band from payer through hold and capture to the worker, and its run log with attempt 1 failing and attempt 2 passing. | "On a pass, PayPal captures the hold and pays the worker by Payout. This sample contract shows the whole path." | FIXTURE |
| 9 | 1:58–2:14 | On the live contract, the Receipt panel: outcome, receipt hash, "signed by the verifier · Ed25519". Copy the command under "Check it yourself", paste it in the terminal, run it. There is one receipt per run, newest first (the pass, then the failed run). Each lists `ok` for receipt hash, signing key, signature, contract id, terms hash, each verdict and each screenshot, then `HOLDS`; the last line reads `every receipt holds`. Hold on the pass's block. (A run repeated with **Re-run the checks** replaces its verdicts, so an earlier receipt for that same submission shows `skip` for them; that is expected.) | "Every run ends in a signed receipt: the terms, each verdict, and hashes of all the evidence. Anyone can check it with one script, without our database. It proves the record wasn't changed after signing." | none (uses the live contract) |
| 10 | 2:14–2:26 | Ledger page `/ledger`: the totals tiles, the AG Grid table with its totals row. Click one flow in the money-flow diagram (for example payouts): the grid filters to those rows and the totals follow. | "The ledger shows every movement PayPal made, live, in AG Grid: holds, captures, payouts, releases and refunds." | FIXTURE rows plus the live contract |
| 11 | 2:26–2:36 | Terminal, full screen: `scripts/agent-demo.ts` output, sped up, ending on the buyer's agent's `check_receipt` (`holds: true`) and "Done.". Keep the "HUMAN STEP" line about the PayPal approval on screen for a moment. | "And AI agents can be the customers. Through our MCP server, a buyer's agent and a worker's agent complete a contract, but funding always stays a human approval in PayPal." | LIVE AI (drafter and verifier); simulated hold |
| 12 | 2:36–2:40 | End card: "Proviso · contracts that pay themselves", the repository URL, "PayPal sandbox · no real money moved". | "Proviso. Contracts that pay themselves." | none |

## Fallbacks for slow live AI calls

- **Drafting (shot 2)** usually answers in 2 to 11 seconds. Record the shot in two takes (refusal, then the clean draft) and cut the spinner to under a second. If a draft takes over 20 seconds or gives a different refusal, keep the rehearsal take instead. Model output varies between runs; the refusal of "look professional" alone was the same in three of three runs on 12 Nov 2026.
- **Verification (shot 5)** took about 10 to 11 seconds per run in QA. Cut each wait with a jump cut. If a run comes back inconclusive (a model call timed out), press **Re-run the checks** and cut, or use the fixture "Crumb & Co. bakery landing page", whose run log shows the same fail-then-pass story, with the "Sample contract" caption.
- **Agent demo (shot 11)** runs a real draft and a real verification and takes up to a minute. Record it in full and speed it up four to six times; the spoken line covers it. If it fails, show the worked example in `docs/agents.md` scrolled in the editor instead.
- **Payout confirmation (shot 8)**: PayPal can take more than a minute to report `SUCCESS`, and the page checks every 10 seconds. Cut the wait, or use 8b.
- **Receipt check (shot 9)** makes no AI call. If the live contract is not available, run the same command with `--no-screenshots` added on the fixture "Crumb & Co. bakery landing page" (its id from the fixture list): both receipts hold. Without `--no-screenshots` the checker prints each fixture screenshot as a long `data:` URI in a `skip` line, because fixture screenshots are stored inline rather than as evidence files, which fills the terminal. Show the "Sample contract" caption. (Checked on 12 Nov 2026 offline against a freshly built fixture database: both receipts held, and editing one word of a verdict's reasoning in the contract JSON made that receipt `DOES NOT HOLD`.)

## After recording

Upload to YouTube (public or unlisted, as Devpost requires), put the link in Devpost's video field and in `[VIDEO URL]` in `docs/submission.md`. If shots 4 and 8 were recorded live and succeeded, the PayPal steps have now been run against the real sandbox: update "Status and limitations" in the README, the marked sentences in `docs/submission.md`, and `docs/runbook.md`.
