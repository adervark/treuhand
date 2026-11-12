# Running the full money path

Real payouts have succeeded against the sandbox from the command line. No real buyer approval, authorize, capture, refund or void has succeeded yet. This is the procedure to prove them.

## One-time setup (developer.paypal.com, Sandbox mode)

1. Testing Tools → Sandbox Accounts → create a **Business** account, country United States.
2. Create two **Personal** accounts, country United States: a payer and a worker.
3. Apps & Credentials → Create App, type Merchant, linked to the new US business account.
4. Edit `.env`:

```
PAYPAL_CLIENT_ID=<new app client id>
PAYPAL_CLIENT_SECRET=<new app secret>
DEMO_PAYER_EMAIL=<sandbox payer email>
DEMO_WORKER_EMAIL=<sandbox worker email>
```

5. Reset and seed, then start:

```sh
rm -f data/clause.db*          # db:init does not clear an existing database
pnpm db:init && pnpm db:seed
pnpm dev        # http://localhost:3000
```

Contracts created before this keep the old emails. Create new ones.

## Happy path

1. As **Payer**: describe a deal, review the draft, save, sign.
2. Switch to **Worker**: sign.
3. As **Payer**: press Fund, log in to the PayPal button as the sandbox payer, approve.
   Expect state FUNDED and a ledger row AUTHORIZED with a real authorization id.
4. As **Worker**: submit a public URL that meets the conditions.
   Expect PASSED, then CAPTURED, then "payout sent".
5. The page sweeps every 30 seconds. To force it:

```sh
curl -X POST http://localhost:3000/api/sweep
```

   Expect PAID and a ledger row PAID_OUT.

## Other paths

- **Expiry:** fund a contract whose deadline is a few minutes away, wait, sweep. Expect EXPIRED and a VOIDED row.
- **Split:** open a dispute, both parties respond, both accept. Expect CAPTURED, REFUNDED and a payout, then SETTLED once PayPal confirms the payout.

## Checks from the command line

```sh
pnpm exec tsx --env-file=.env scripts/paypal-smoke.ts order            # token + create a held-payment order, prints the approve link
pnpm exec tsx --env-file=.env scripts/paypal-smoke.ts capture <orderId> # after approving: authorize, capture, refund
pnpm exec tsx --env-file=.env scripts/paypal-smoke.ts void <orderId>    # after approving: authorize, void
pnpm exec tsx --env-file=.env scripts/paypal-smoke.ts payout <worker email>        # replay: "same batch recovered"; then SUCCESS / PAID
pnpm exec tsx --env-file=.env scripts/paypal-smoke.ts payout-retry <worker email>  # is a refused payout retryable under the same key?
```

Afterwards, check the activity page of all three sandbox accounts.

## Not yet exercised

- **Webhooks:** need a public HTTPS URL for `/api/webhooks/paypal` and `PAYPAL_WEBHOOK_ID` in `.env`. Nothing depends on them.
