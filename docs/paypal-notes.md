# PayPal sandbox reference for Treuhand (holds by authorization, payouts by email)

Checked against PayPal's own docs and repos on 2026-11-11. Every claim carries a label and a source.

- **confirmed from docs**: stated in an official PayPal page, PayPal's OpenAPI spec, or PayPal's own source code.
- **inferred**: follows from documented facts but is not stated anywhere. Test it before relying on it.
- **could not confirm**: no official source found.

Sandbox REST base URL: `https://api-m.sandbox.paypal.com`. Get a token with `POST /v1/oauth2/token`, using Basic auth (`client_id:client_secret`) and the form body `grant_type=client_credentials`. **confirmed from docs** ([REST get started](https://developer.paypal.com/api/rest/)).

## Sources actually read

- **developer.paypal.com** was not blocked. WebFetch works, and every docs page also has a raw Markdown copy at the same path plus `.md`, which plain `curl` fetches (for example `https://developer.paypal.com/payment-methods/auth-honor.md`). The index is at `https://developer.paypal.com/llms.txt`. Old `/docs/...` URLs return 301 redirects to the new paths.
- **PayPal OpenAPI specs** (raw GitHub), last updated 2026-04-07: [checkout_orders_v2.json](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/checkout_orders_v2.json) (v2.32), [payments_payment_v2.json](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/payments_payment_v2.json) (v2.12), [payments_payouts_batch_v1.json](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/payments_payouts_batch_v1.json) (v1.9), [notifications_webhooks_v1.json](https://github.com/paypal/paypal-rest-api-specifications/blob/main/openapi/notifications_webhooks_v1.json).
- **github.com/paypal/agent-toolkit** (raw): the README and `typescript/` source (`src/shared/tools.ts`, `functions.ts`, `payloadUtils.ts`, `configuration.ts`, `client.ts`, `src/ai-sdk/*`, `src/modelcontextprotocol/*`, `package.json`). The last commit is 2026-09-01 (v1.11.0). I also checked npm registry metadata.
- **github.com/paypal-examples/v6-web-sdk-sample-integration** (raw), last commit 2026-10-30.
- **paypal.com legal pages**: these return 403 to WebFetch and to plain curl, but 200 to curl with browser headers. I read the [Acceptable Use Policy](https://www.paypal.com/us/legalhub/paypal/acceptableuse-full) and the [User Agreement](https://www.paypal.com/us/legalhub/paypal/useragreement-full), both US versions, last updated 2026-11-04.

---

## 1. Orders v2 with `intent: AUTHORIZE`

### Honor period and validity

**confirmed from docs.** An authorization holds the funds for a **29-day authorization period**. The first **3 days** are the **honor period**, when capture is most likely to succeed. After that, "capture success depends on risk assessment and fund availability". The honor period makes capture likely, not guaranteed. Sources: [Authorization and honor period](https://developer.paypal.com/payment-methods/auth-honor), [Authorize and capture (v5)](https://developer.paypal.com/v5/checkout/auth-capture).

**Reauthorization**

- **confirmed from docs.** Reauthorization is allowed from day 4 to day 29. It returns a **new authorization ID** and restarts the 3-day honor period, and later captures must use the new ID. After 30 days you must create a new authorization. Reauthorizing within the honor period fails with the error `REAUTHORIZATION_TOO_SOON`. Sources: the `reauthorize` operation and error list in the payments spec, and [auth-honor](https://developer.paypal.com/payment-methods/auth-honor).
- **Docs conflict on how many times you can reauthorize.** The endpoint description and the auth-honor page say "multiple reauthorizations" are allowed. The spec's `reauthorize_request` schema says "You can reauthorize a payment only once from days four to 29." Plan for a single reauthorization.
- **Two pages contradict the 29-day rule.** [Extend an authorization](https://developer.paypal.com/checkout/extend-authorization) says "In the United States, authorizations are valid for 3 days, and up to 29 days in other regions." [Void](https://developer.paypal.com/checkout/void-authorized-payment) says "Authorizations expire after 3 days (standard) or 29 days (honor period)." Both disagree with auth-honor and the API spec. I treat them as errors in those pages.

**Expiry**

- **confirmed from docs.** At the end of the validity period, PayPal voids the authorization itself and sends `PAYMENT.AUTHORIZATION.VOIDED`. The event description says "due to authorization reaching its 30 day validity period" ([event names](https://developer.paypal.com/api/rest/webhooks/event-names/)).
- **confirmed from docs. This matters for the demo:** "Sandbox authorizations don't expire after 29 days. Test authorizations with negative testing instead." ([Delay capture](https://developer.paypal.com/checkout/delay-capture)). Our deadline logic must call void itself.

**Partial capture**

- **confirmed from docs.** The capture body takes an optional `amount`. If you omit it, the full authorized amount is captured. `final_capture` defaults to `false`, and you set it to `true` when no more captures will follow (payments spec, `capture_request`).
- **confirmed from docs.** "You can capture any amount up to the authorized total. The remainder can be voided or left to expire." ([Delay capture](https://developer.paypal.com/checkout/delay-capture))
- **confirmed from docs.** "For PayPal payment authorizations, you must enable partial capture on your PayPal account." ([auth-honor](https://developer.paypal.com/payment-methods/auth-honor))
- **could not confirm** how to enable partial capture, or whether it is already on for sandbox accounts.

**Void**

- **confirmed from docs.** A void is all-or-nothing. A fully captured authorization cannot be voided. The errors are `PREVIOUSLY_CAPTURED` (from the spec) and `AUTHORIZATION_ALREADY_CAPTURED` / `AUTHORIZATION_VOIDED` (from the guide). In sandbox, the voided funds are released immediately. Sources: [Void guide](https://developer.paypal.com/checkout/void-authorized-payment), payments spec.
- **inferred.** Voiding after a partial capture releases the remainder, because the spec only forbids voiding a *fully* captured authorization.

### REST calls

All paths below are **confirmed from docs** (Orders and Payments specs, [Orders v2 reference](https://developer.paypal.com/docs/api/orders/v2/), [Payments v2 reference](https://developer.paypal.com/docs/api/payments/v2/)).

| Step | Call |
|---|---|
| Create order | `POST /v2/checkout/orders` |
| Show order | `GET /v2/checkout/orders/{order_id}` |
| Authorize after buyer approval | `POST /v2/checkout/orders/{order_id}/authorize` (body optional: the spec has `requestBody.required=false`) |
| Show authorization | `GET /v2/payments/authorizations/{authorization_id}` |
| Capture authorization (full or partial) | `POST /v2/payments/authorizations/{authorization_id}/capture` |
| Reauthorize | `POST /v2/payments/authorizations/{authorization_id}/reauthorize` (only `amount` is supported) |
| Void | `POST /v2/payments/authorizations/{authorization_id}/void` (no body) |
| Show capture | `GET /v2/payments/captures/{capture_id}` |

```http
POST /v2/checkout/orders
Authorization: Bearer <token>
Content-Type: application/json
PayPal-Request-Id: <uuid>
Prefer: return=representation

{
  "intent": "AUTHORIZE",
  "purchase_units": [{
    "reference_id": "contract_123",
    "custom_id": "contract_123",
    "amount": { "currency_code": "USD", "value": "100.00" }
  }]
}
```

Only `intent` and `purchase_units[].amount` are required. `custom_id` (up to 255 characters) is not shown to the payer and appears in reports. **confirmed from docs** (Orders spec, `order_request` and `purchase_unit_request`).

Avoid `invoice_id` on test orders unless every value is unique. "invoice_id values are required to be unique within each merchant account by default" (Orders spec).

```http
POST /v2/checkout/orders/{order_id}/authorize
Authorization: Bearer <token>
Content-Type: application/json
PayPal-Request-Id: <uuid>
Prefer: return=representation

{}
```

Store `purchase_units[0].payments.authorizations[0].id`, `.status` and `.expiration_time` from the response. **confirmed from docs** ([Delay capture](https://developer.paypal.com/checkout/delay-capture): "Store this value in your database immediately"; the field list is from the payments spec, `authorization`).

Authorization statuses: `CREATED`, `CAPTURED`, `DENIED`, `PARTIALLY_CAPTURED`, `VOIDED`, `PENDING`. **confirmed from docs** (payments spec, `authorization_status`).

```http
POST /v2/payments/authorizations/{authorization_id}/capture
PayPal-Request-Id: <uuid>
Content-Type: application/json

{}                                                                  // full capture
{ "amount": { "currency_code": "USD", "value": "70.00" }, "final_capture": true }   // partial capture
```

The capture response returns a capture `id` (needed for refunds) and a `status` of `COMPLETED`, `DECLINED`, `PARTIALLY_REFUNDED`, `PENDING`, `REFUNDED` or `FAILED` (payments spec).

### Do not use the order-capture endpoint on an AUTHORIZE order

**confirmed from docs.** Calling `POST /v2/checkout/orders/{id}/capture` on an order created with `intent=AUTHORIZE` returns HTTP 422 with `ACTION_DOES_NOT_MATCH_INTENT` (Orders spec example). Capture through `/v2/payments/authorizations/{id}/capture` instead.

### Headers

- **`PayPal-Request-Id`** (idempotency). **confirmed from docs.** If you resend the same ID, PayPal returns the result of the first request instead of repeating the action. If you omit the header, "PayPal duplicates the request". If two requests with the same ID arrive at the same time, the second may fail ([Idempotency](https://developer.paypal.com/api/rest/reference/idempotency)). PayPal keeps the ID for 6 hours on Orders, extendable to 72 hours by your account manager (Orders spec), and for 30 days on Payouts (Payouts spec). The Payments spec accepts the header on capture, reauthorize, void and refund but does not state a retention period. **observed in the sandbox: Payouts do not replay.** A payout resent with the same `PayPal-Request-Id` and the same `sender_batch_id` is refused with HTTP 400, not answered with the first batch (section 2).
- **`Prefer`**. **confirmed from docs.** `return=minimal` is the default and returns id, status and links. `return=representation` returns the full resource.
- **`PayPal-Mock-Response`** (sandbox negative testing). **confirmed from docs.** First enable Negative Testing on the sandbox business account (Dashboard > Sandbox > Accounts > ... > View/Edit). Then send `PayPal-Mock-Response: {"mock_application_codes":"AUTHORIZATION_EXPIRED"}` to simulate an expired hold on stage ([Checkout quick start](https://developer.paypal.com/checkout/integrate), [Delay capture](https://developer.paypal.com/checkout/delay-capture)).

---

## 2. Payouts API

### Endpoints

All **confirmed from docs** (Payouts spec, [Use Payouts API](https://developer.paypal.com/api/payouts)).

| Call | Path |
|---|---|
| Create batch | `POST /v1/payments/payouts` (returns 201) |
| Batch status | `GET /v1/payments/payouts/{payout_batch_id}` (includes per-item status) |
| Item status | `GET /v1/payments/payouts-item/{payout_item_id}` |
| Cancel unclaimed item | `POST /v1/payments/payouts-item/{payout_item_id}/cancel` |

### Minimal body for one email recipient

```http
POST /v1/payments/payouts
Authorization: Bearer <token>
Content-Type: application/json
PayPal-Request-Id: <uuid>

{
  "sender_batch_header": {
    "sender_batch_id": "contract_123_payout_1",
    "email_subject": "You have a payout!"
  },
  "items": [{
    "recipient_type": "EMAIL",
    "amount": { "value": "70.00", "currency": "USD" },
    "receiver": "sb-worker@personal.example.com",
    "note": "Contract 123 milestone",
    "sender_item_id": "contract_123_item_1"
  }]
}
```

The Payouts amount uses `currency`, not `currency_code` as in Orders and Payments. **confirmed from docs** (Payouts spec, `currency` schema).

`sender_batch_id` must be unique for 30 days. A duplicate is rejected with a link to the original batch, and after an HTTP 5xx you can safely retry with the same ID. **confirmed from docs** (Payouts spec). The spec has no way to look a batch up by `sender_batch_id`: a batch is read only by `payout_batch_id` (`GET /v1/payments/payouts/{id}`). **confirmed from docs** (Payouts spec, paths).

**observed in the sandbox** (2026-11-11, US sandbox app, batches 3SEXEDAZDD4F8, T7QZF8UBV96CA and 3CUFP29EPXDJN). The duplicate is refused even when the `PayPal-Request-Id` is the same too, so PayPal never replays a payout. The refusal, in full:

```http
HTTP/1.1 400
paypal-debug-id: ca5901aa15ccf

{
  "name": "USER_BUSINESS_ERROR",
  "message": "User business error.",
  "debug_id": "ca5901aa15ccf",
  "information_link": "https://developer.paypal.com/docs/api/payments.payouts-batch/#errors",
  "details": [{
    "field": "SENDER_BATCH_ID",
    "location": "body",
    "issue": "Batch with given sender_batch_id already exists",
    "link": [{ "href": "https://api.sandbox.paypal.com/v1/payments/payouts/T7QZF8UBV96CA",
               "rel": "self", "method": "GET", "encType": "application/json" }]
  }],
  "links": []
}
```

- The link to the existing batch is in `details[].link`; the top-level `links` is empty. Its host is `api.sandbox.paypal.com`, not `api-m.sandbox.paypal.com`. No response header carries anything beyond `paypal-debug-id`.
- Read back within a second of creation, the batch already lists its item with amount, receiver and `sender_item_id`, and its `batch_header.sender_batch_header.sender_batch_id`.
- How `payout` (src/lib/paypal) uses it: on this refusal it takes the batch id from the end of the href, reads the batch through its own API base, and returns it marked `recovered: true` only if the batch's `sender_batch_id` is the one sent and its one item pays the same amount and currency to the same receiver. Anything else is an error, never a payout sent. So a payout whose response was lost (a timeout, a crash) is recorded on the next try instead of failing forever.
- A payout refused outright leaves no batch. One refused with HTTP 422 `INSUFFICIENT_FUNDS` and resent under the same `PayPal-Request-Id` and `sender_batch_id` created a new batch (smoke script `payout-retry`, batch NT892BEETV3KA): the refusal was not replayed and did not use up the `sender_batch_id`.

The response contains `batch_header.payout_batch_id` and `batch_status: "PENDING"`. Payouts are asynchronous, so poll or use webhooks. **confirmed from docs.**

### Statuses

**confirmed from docs** (Payouts spec, `batch_enum` and `transaction_enum`).

- **Batch:** `DENIED`, `PENDING`, `PROCESSING`, `SUCCESS`, `CANCELED`. `SUCCESS` means the batch was processed, so check each item for holds or unclaimed transactions.
- **Item (`transaction_status`):** `SUCCESS`, `FAILED`, `PENDING`, `UNCLAIMED`, `RETURNED`, `ONHOLD`, `BLOCKED`, `REFUNDED`, `REVERSED`. `UNCLAIMED` means the recipient has no PayPal account. Unclaimed money returns to the sender after 30 days.

### Sandbox enablement

- **confirmed from docs.** Live use requires asking PayPal for Payouts access: "To use PayPal Payouts, you'll need to request access" ([Payouts overview](https://developer.paypal.com/docs/payouts/standard/), [set-up](https://developer.paypal.com/payouts/use-payouts/set-up)). The sandbox set-up steps (create a Merchant app, add a sandbox webhook, get credentials) contain no access request. While you wait for live access, "you can set up and test your integration in your sandbox accounts."
- **could not confirm from official docs** that a sandbox app has a "Payouts" checkbox under its Features. Only third-party write-ups say so.
- **inferred.** The sample token response on [JS SDK v6 set-up](https://developer.paypal.com/sdk/js/set-up) includes the scope `https://uri.paypal.com/payments/payouts`. Check the `scope` field of your own token for that string. If it is missing, or a payout returns `AUTHORIZATION_ERROR` or `REQUIRED_SCOPE_MISSING`, look for a Payouts toggle in the app's Features.

### Balance

- **confirmed from docs.** "Payouts are funded using your PayPal balance, so be sure to add enough to cover your payout total, including fees." A shortfall returns the error `INSUFFICIENT_FUNDS`.
- **confirmed from docs.** New sandbox accounts are created "with a default balance", and you can set the PayPal balance when you create an account ([Sandbox accounts](https://developer.paypal.com/sandbox-testing/accounts)).
- **confirmed from docs.** The sandbox charges simulated PayPal fees on captures. The webhook guide's sample capture of $500.00 shows `paypal_fee` 25.44 and `net_amount` 474.56 ([webhooks integration](https://developer.paypal.com/api/rest/webhooks/rest/)).

### Common sandbox failures

**confirmed from docs.** [Test and go live](https://developer.paypal.com/api/payouts/test-go-live) lets you trigger each error with a magic value: put the code in `items[0].note` on POST, or in the path on GET. For example, `ERRPYO002` triggers `SENDER_EMAIL_UNCONFIRMED`. Errors that apply to us:

- `INSUFFICIENT_FUNDS` (ERRPYO005)
- `AUTHORIZATION_ERROR` (ERRPYO003)
- `REQUIRED_SCOPE_MISSING` (ERRPYO011)
- `RECEIVER_UNREGISTERED` (ERRPYO022)
- `RECEIVER_UNCONFIRMED` (ERRPYO021)
- `SELF_PAY_NOT_ALLOWED` (ERRPYO028)
- `DUPLICATE_ITEM` (ERRPYO018)
- `CURRENCY_NOT_SUPPORTED_FOR_RECEIVER` (ERRPYO017)
- `RATE_LIMIT_VALIDATION` (ERRPYO035). The documented limit is 400 POST requests per minute.

To make the money visibly land, pay a real sandbox personal account email. An address with no account produces `UNCLAIMED`. **inferred** from the `UNCLAIMED` definition.

---

## 3. Refunds (partial refund of a capture)

**confirmed from docs.** Use `POST /v2/payments/captures/{capture_id}/refund`. An empty body `{}` refunds the remaining amount: "captured amount - previous refunds". Send `amount` for a partial refund. Refunding more than remains returns `REFUND_AMOUNT_EXCEEDED`. Sources: payments spec, [Payments v2 reference](https://developer.paypal.com/docs/api/payments/v2/).

```http
POST /v2/payments/captures/{capture_id}/refund
Authorization: Bearer <token>
Content-Type: application/json
PayPal-Request-Id: <uuid>

{ "amount": { "value": "30.00", "currency_code": "USD" }, "note_to_payer": "Mediated split: 30% returned" }
```

To read a refund back, use `GET /v2/payments/refunds/{refund_id}`. Refund statuses are `CANCELLED`, `FAILED`, `PENDING` and `COMPLETED`.

**could not confirm** a refund time limit in the current docs or spec.

---

## 4. Webhooks

### Verify a signature with the API

**confirmed from docs** (webhooks spec, [webhooks integration](https://developer.paypal.com/api/rest/webhooks/rest/)).

```http
POST /v1/notifications/verify-webhook-signature
Authorization: Bearer <token>
Content-Type: application/json

{
  "auth_algo":         "<PAYPAL-AUTH-ALGO header, e.g. SHA256withRSA>",
  "cert_url":          "<PAYPAL-CERT-URL header>",
  "transmission_id":   "<PAYPAL-TRANSMISSION-ID header>",
  "transmission_sig":  "<PAYPAL-TRANSMISSION-SIG header>",
  "transmission_time": "<PAYPAL-TRANSMISSION-TIME header>",
  "webhook_id":        "<your webhook ID from the dashboard, NOT from the request>",
  "webhook_event":     <the event body exactly as received>
}
-> 200 { "verification_status": "SUCCESS" | "FAILURE" }
```

- All seven fields are required.
- "It is essential that the webhook_event data be posted back exactly as it was received."
- Keep the raw request body. Do not re-serialize the event JSON.
- The guide lists four headers in lowercase (`paypal-transmission-id`, `-time`, `-sig`, `-cert-url`). The spec says `auth_algo` comes from the `PAYPAL-AUTH-ALGO` header.

**Offline verification** (also documented): sign the string `transmissionId|timeStamp|webhookId|crc32` with SHA256, where crc32 is the decimal CRC32 of the raw body. Check it against the certificate at `paypal-cert-url`.

### Event names

All **confirmed from docs** ([event names](https://developer.paypal.com/api/rest/webhooks/event-names/), [Payouts webhooks](https://developer.paypal.com/payouts/webhooks)).

| Moment | Event |
|---|---|
| Buyer approved order | `CHECKOUT.ORDER.APPROVED` |
| Authorization created | `PAYMENT.AUTHORIZATION.CREATED` |
| Authorization voided (manually or by expiry) | `PAYMENT.AUTHORIZATION.VOIDED` |
| Capture completed / pending / declined | `PAYMENT.CAPTURE.COMPLETED` / `PAYMENT.CAPTURE.PENDING` / `PAYMENT.CAPTURE.DECLINED` (Payments v2; v1 lists `.DENIED`) |
| Capture refunded / reversed | `PAYMENT.CAPTURE.REFUNDED` / `PAYMENT.CAPTURE.REVERSED` |
| Payout batch | `PAYMENT.PAYOUTSBATCH.SUCCESS` / `.DENIED` / `.PROCESSING` |
| Payout item | `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` / `.FAILED` / `.BLOCKED` / `.CANCELED` / `.HELD` / `.REFUNDED` / `.RETURNED` / `.UNCLAIMED` |

The batch-level events (`PAYOUTSBATCH`) "do not contain item-related information". Follow the HATEOAS links in the event to get item status.

### Register a webhook

**confirmed from docs.** Either way, you need the resulting **Webhook ID** for verification.

- **Dashboard:** Apps & Credentials > (sandbox app) > Features > **Sandbox Webhooks** > **Add Webhook**. Enter the URL and pick events; `*` subscribes to all of them ([Payouts set-up](https://developer.paypal.com/payouts/use-payouts/set-up), [webhooks overview](https://developer.paypal.com/api/rest/webhooks/)).
- **API:**

```http
POST /v1/notifications/webhooks
{ "url": "https://<public-host>/api/webhooks/paypal",
  "event_types": [ { "name": "PAYMENT.AUTHORIZATION.CREATED" }, { "name": "PAYMENT.AUTHORIZATION.VOIDED" } ] }
```

Limits and behaviour: up to 10 webhook URLs per app. A webhook receives only events from its own app. PayPal retries any non-2xx response up to 25 times over 3 days. **confirmed from docs.**

### Localhost during development

- **confirmed from docs.** "Your listener should be an app or script deployed at the corresponding URL that listens on HTTPS port 443", and "Development ports can be used in a forwarding configuration, set 443 if this is front-facing."
- **inferred.** You need a public HTTPS tunnel (for example ngrok or cloudflared) or a deployed URL. PayPal's docs do not name any tunnel tool.
- **confirmed from docs.** The [Webhooks simulator](https://developer.paypal.com/api/rest/webhooks/simulator/) at `/dashboard/webhooksSimulator/` posts mock events to any HTTPS:443 URL. Simulated events have these limits:
  - They cannot be verified through `verify-webhook-signature`.
  - They are not tied to any app and do not appear in the event viewer.
  - Offline verification works only with the literal webhook ID `WEBHOOK_ID`.
  - The API equivalent is `POST /v1/notifications/simulate-event` with `{ "webhook_id" or "url", "event_type" }`.

---

## 5. JavaScript SDK for the checkout button

### Which version is current

**confirmed from docs.** **v6 is current.** `developer.paypal.com/sdk/js/` now only documents v6. The upgrade guide labels the v5 script tag `<!-- v5 (deprecated) -->`, but the v5 docs are still published under `/sdk/js/v5/`. Sources: [Set up JS SDK v6](https://developer.paypal.com/sdk/js/set-up), [Upgrade v5 to v6](https://developer.paypal.com/v5-v6), [v5 configuration](https://developer.paypal.com/sdk/js/v5/configuration).

### Loading v6

**confirmed from docs.**

- Sandbox script: `https://www.sandbox.paypal.com/web-sdk/v6/core`. Production: `https://www.paypal.com/web-sdk/v6/core`.
- Initialise in the script's `onload` callback, not inline and not in `DOMContentLoaded`.
- Authenticate with a client ID. A client token is needed only for Fastlane.
- The v5 default test ID is no longer accepted.

### AUTHORIZE with v6

- **inferred.** v6 has no client-side `intent` setting; the server decides the intent when it creates the order. So with v6 you create the order server-side with `intent: AUTHORIZE`, and `onApprove` calls your server to run `/authorize` instead of capture.
- **could not confirm** a v6 page that shows authorize. PayPal's v6 sample server does accept an `intent` enum for order creation (default `CAPTURE`) in `server/node/src/routes/ordersRouteHandler.ts`.
- **Spike this in the first hour.**

### Is v6 harder than v5?

It is somewhat more code (an explicit eligibility check, a custom element and a session object) but not materially harder.

### Doc inconsistencies on v6

- On the set-up page, the `createInstance` table marks `clientToken` as required, but the same page recommends `clientId`, and PayPal's sample uses `clientId`.
- The set-up page says the order promise must resolve to `{ orderId }`, but the upgrade guide's example resolves to a plain string. PayPal's sample resolves to `{ orderId: data.id }`, so follow the sample.

### v6 code

Pattern taken from PayPal's v6 sample `client/components/paypalPayments/oneTimePayment/html/src/recommended/`.

```html
<paypal-button id="paypal-button" type="pay" hidden></paypal-button>
<script src="/app.js"></script>
<script async src="https://www.sandbox.paypal.com/web-sdk/v6/core" onload="onPayPalWebSdkLoaded()"></script>
```

```js
async function onPayPalWebSdkLoaded() {
  const sdk = await window.paypal.createInstance({
    clientId: PAYPAL_CLIENT_ID,            // sandbox app client ID (public)
    components: ["paypal-payments"],
    pageType: "checkout",
  });
  const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
  if (!methods.isEligible("paypal")) return;

  const session = sdk.createPayPalOneTimePaymentSession({
    async onApprove({ orderId }) {
      // server: POST /v2/checkout/orders/{orderId}/authorize, store authorization id
      const r = await fetch(`/api/contracts/${CONTRACT_ID}/fund/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      if (!r.ok) throw new Error("authorize failed");
    },
    onCancel() {},
    onError(err) { console.error(err); },
  });

  const btn = document.getElementById("paypal-button");
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    // Do not await before start(): PayPal's sample warns it breaks the click's transient activation.
    const orderPromise = fetch(`/api/contracts/${CONTRACT_ID}/fund/order`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => ({ orderId: d.id }));   // server created the order with intent AUTHORIZE
    await session.start({ presentationMode: "auto" }, orderPromise);
  });
}
```

### v5 fallback

**confirmed from docs** ([v5 auth-capture](https://developer.paypal.com/v5/checkout/auth-capture), [v5 configuration](https://developer.paypal.com/sdk/js/v5/configuration)).

- `&intent=authorize` is required. The default is `capture`, and the docs say the intent in the script must match the API call.
- `createOrder` returns the order ID string.
- `onApprove` receives `data.orderID`.

```html
<div id="paypal-button-container"></div>
<script src="https://www.paypal.com/sdk/js?client-id=SANDBOX_CLIENT_ID&intent=authorize"></script>
<script>
  paypal.Buttons({
    createOrder: () =>
      fetch(`/api/contracts/${CONTRACT_ID}/fund/order`, { method: "POST" })
        .then((r) => r.json()).then((d) => d.id),
    onApprove: (data) =>
      fetch(`/api/contracts/${CONTRACT_ID}/fund/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: data.orderID }),
      }),
  }).render("#paypal-button-container");
</script>
```

---

## 6. `@paypal/agent-toolkit` (TypeScript)

### Version

**confirmed from docs.** Version **1.11.0**, published 2026-09-01. It requires Node 18+ and exports `@paypal/agent-toolkit/ai-sdk`, `/mcp`, `/langchain`, `/openai` and `/bedrock`, with **no Anthropic-specific export**. The MCP server package is `@paypal/mcp` 1.8.1 (published 2025-10-28), which depends on `@paypal/agent-toolkit@latest`. Sources: [npm](https://www.npmjs.com/package/@paypal/agent-toolkit), `typescript/package.json`.

### Tools it exposes

**confirmed from docs** (from `typescript/src/shared/tools.ts`).

- **Payments**
  - `create_order`
  - `get_order`
  - `pay_order`, which needs the action flag `orders.capture`
  - `create_refund` (`payments.createRefund`)
  - `get_refund` (`payments.getRefunds`)
- **Reporting:** `list_transactions` (`transactions.list`), `get_merchant_insights`
- **Other groups:** invoices (about 20 tools), disputes (`list_disputes`, `get_dispute`, `accept_dispute_claim`), shipment tracking, catalog products, and subscriptions.

### What it does not do

**No authorize, no capture of an authorization, no void, no reauthorize, no Payouts, and no webhooks.** Searching the source for `payout`, `authoriz` and `void` finds nothing. **confirmed from docs.**

**Both order tools are capture-only.** **confirmed from docs.**

- `create_order` hard-codes `intent: 'CAPTURE'` (`src/shared/payloadUtils.ts`, line 197).
- `pay_order` calls `POST /v2/checkout/orders/{id}/capture` (`src/shared/functions.ts`). PayPal rejects that call on an AUTHORIZE order with `ACTION_DOES_NOT_MATCH_INTENT`.
- Neither tool works for Treuhand's hold-then-pay flow.

### What must be direct REST

Create the AUTHORIZE order, authorize, capture the authorization, void, reauthorize, Payouts (create and status), and webhook register/verify.

### What the toolkit can honestly do for the agents

- `get_order`, to read order state.
- `create_refund` and `get_refund`. These work on any capture, including one taken from an authorization, because they call `/v2/payments/captures/{id}/refund`.
- `list_transactions`, for the ledger and reconciliation.
- Optionally `create_invoice`, or the dispute tools.

### Initialising for the sandbox (Vercel AI SDK)

**confirmed from docs** (README and `src/shared/client.ts`, `configuration.ts`). Two gotchas found in the source:

1. `configuration.actions` is effectively required. `isToolAllowed` indexes `configuration.actions[...]` without a guard, so the README's sandbox-only snippet must be merged with an `actions` object.
2. The AI SDK and OpenAI toolkits default to **live**. The code is `sandbox ?? false`, with base URL `https://api.paypal.com`. Only the MCP server defaults to `SANDBOX` (through `PAYPAL_ENVIRONMENT`).

```ts
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";

const paypal = new PayPalAgentToolkit({
  clientId: process.env.PAYPAL_CLIENT_ID!,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  configuration: {
    actions: {
      orders: { get: true },
      payments: { createRefund: true, getRefunds: true },
      transactions: { list: true },
    },
    context: { sandbox: true },   // REQUIRED, otherwise calls go to live
  },
});
// generateText({ model, tools: paypal.getTools(), ... })
```

### AI SDK version clash

- **confirmed from docs.** The toolkit depends on `ai@^4.0.23` and builds tools with the v4 `tool({ parameters })` shape. The current `ai` release on npm is 7.0.169.
- **inferred.** Passing these tools into AI SDK 5 or later (which uses `inputSchema`) may break. Either pin `ai@4` together with an `@ai-sdk/anthropic` version that is compatible with it, or use MCP.

### MCP (works with any MCP client, including Claude)

**confirmed from docs** ([MCP server quickstart](https://developer.paypal.com/ai-tools/mcp-server)).

```json
{ "mcpServers": { "paypal": {
    "command": "npx",
    "args": ["-y", "@paypal/mcp", "--tools=all"],
    "env": { "PAYPAL_ACCESS_TOKEN": "<sandbox token>", "PAYPAL_ENVIRONMENT": "SANDBOX" } } } }
```

- A remote server is also available at `https://mcp.sandbox.paypal.com/http` (streamable HTTP) or `/sse`, with the header `Authorization: Bearer <token>`.
- In-process, `@paypal/agent-toolkit/mcp` exports `PayPalAgentToolkit extends McpServer`, constructed with `{ accessToken, configuration }`.
- Sandbox access tokens last "3-8 hours" (README), so plan to refresh them.
- **could not confirm** the remote MCP server's tool list. It is hosted by PayPal and may differ from the npm package.

---

## 7. Sandbox setup

All **confirmed from docs** ([REST get started](https://developer.paypal.com/api/rest/), [Sandbox accounts](https://developer.paypal.com/sandbox-testing/accounts), [Payouts set-up](https://developer.paypal.com/payouts/use-payouts/set-up)), except where marked.

1. Sign up for or log in to the [Developer Dashboard](https://developer.paypal.com/dashboard/). PayPal automatically creates a **default business** and a **default personal** sandbox account.
2. Toggle to **Sandbox**. Go to **Apps & Credentials** > **Create App**, choose Type **Merchant**, pick the sandbox business account, and create it. Copy the **Client ID** and **Client secret**. A "Default Application" may already exist.
3. **Testing Tools** > **Sandbox Accounts** > **Create account**. Use Personal for a buyer and Business for a seller, and pick a country. Each account gets a generated email (`sb-...@personal.example.com`) and password and a default balance. Use **Create** at the bottom of the dialog to set your own email, password or balance.
4. Create **three** accounts: the business account that owns the app (receives captures, sends payouts), a personal **payer**, and a separate personal **worker** to receive payouts. Payouts to yourself fail with `SELF_PAY_NOT_ALLOWED`. **inferred** that a separate worker account is cleanest.
5. In the app, go to **Features** > **Sandbox Webhooks** > **Add Webhook** and save the Webhook ID as `PAYPAL_WEBHOOK_ID`.
6. Optional: on the business account, open **View/Edit** and turn on **Negative Testing** so you can force `AUTHORIZATION_EXPIRED` and similar errors.

Things to switch on that I could not pin down:

- Payouts checkbox: see section 2. **could not confirm.**
- Partial capture on the account: see section 1. **could not confirm** how.

---

## 8. Marketplace hold: "delayed disbursement" (pitch only)

**confirmed from docs** ([Delay disbursement](https://developer.paypal.com/platforms/checkout/delayed-disbursement), [Platforms get started](https://developer.paypal.com/platforms/get-started)).

PayPal's multiparty platform (PayPal Complete Payments Platform) lets a marketplace take the buyer's payment, with the seller set as the order's `payee`, and set `payment_instruction.disbursement_mode: "DELAYED"`. PayPal then holds the captured funds instead of releasing them to the seller. The platform releases them later with `POST /v1/payments/referenced-payouts-items`, referencing the capture ID. It works with both `AUTHORIZE` and `CAPTURE` intents.

- **Hold limit:** "Funds are automatically disbursed to the seller after 28 days, and PayPal deducts fees from the seller's funds."
- **Approval:** you must be an **approved partner**. Without approval, live calls return 401, though "You can call and test ... with your sandbox credentials before you are approved".
- **Seller onboarding:** each seller must be onboarded with the `DELAY_FUNDS_DISBURSEMENT` feature.
- **Pitch consequence:** in that version the worker must be an onboarded PayPal seller, not just an email address.

---

## 9. Acceptable Use Policy and User Agreement on escrow

**confirmed from docs.**

The [Acceptable Use Policy](https://www.paypal.com/us/legalhub/paypal/acceptableuse-full) (US, last updated Nov 4, 2026) puts escrow under "Activities Requiring Approval":

> "4 Payment Facilitator: Providing payment services which would fall under the definition of a money service business or an electronic money institution. Services would also include the sale of stored value cards and escrow services."

The same policy prohibits transactions that "relate to transactions involving any activity that requires pre-approval without having obtained said approval", and points to PayPal's Sales team for pre-approval.

The [User Agreement](https://www.paypal.com/us/legalhub/paypal/useragreement-full) (US, last updated Nov 4, 2026):

> "PayPal is only a payment service provider ... We do not: Act as an escrow agent with respect to any funds kept in your account"

---

## Early assumptions the docs corrected

1. **"An authorization is guaranteed for 3 days."** The 3 days are an honor period with the best capture odds, not a guarantee: "Payment capture is subject to risk and money availability." The 29-day maximum is correct.
2. **"Authorization holds last days, not weeks."** Holds are valid for 29 days, and you can reauthorize from day 4 (docs conflict on whether more than once).
3. **"On expiry, void"** needs our own timer. Sandbox authorizations never expire on their own. Demo the expiry by calling void ourselves, or force `AUTHORIZATION_EXPIRED` with `PayPal-Mock-Response`.
4. **"The AI agents call PayPal through PayPal's own agent tooling."** The toolkit cannot authorize, capture an authorization, void or pay out. Its `create_order` is CAPTURE-only, and `pay_order` would fail on our orders. Settlement must be direct REST, which is what Treuhand does. The agents' PayPal tools are realistically `get_order`, `create_refund`/`get_refund` and `list_transactions`, or the MCP server. The toolkit also pins `ai@^4`.
5. **JS SDK v6 with AUTHORIZE is undocumented.** No official v6 page shows the authorize flow. It should work because the intent is set on the server, but spike it first. The documented fallback is v5 with `&intent=authorize`, which is labeled deprecated.
6. **Webhooks need a public HTTPS:443 URL.** There is no localhost delivery, and simulator events cannot be verified through the API. Use a tunnel or the deployed URL, and also poll `GET` the authorization or payout batch so the demo does not depend on webhooks arriving.
7. **The split flow needs a caveat.** "Capture, partial payout, partial refund" is fully documented and is the safe path. The cheaper variant, a partial capture of only the worker's share with `final_capture: true`, depends on partial capture being enabled on the account, which I could not confirm for the sandbox.
8. **Payouts leave the platform balance, fees included.** After a capture the platform holds gross minus the simulated PayPal fee, so paying the worker the full gross amount draws on the sandbox default balance. Fine for a demo, but it is not "the same money".
9. **"PayPal policy may require approval for escrow."** Confirmed: the AUP lists escrow services as needing pre-approval, and the User Agreement says PayPal does not act as an escrow agent.
10. **The production pitch "PayPal holds the funds" is real, with limits.** Delayed disbursement holds funds for at most 28 days, requires approved-partner status, and requires the worker to be onboarded as a seller. That conflicts with "the payee only needs an email address". Only the Payouts path keeps email-only payees.
