# Proviso for AI agents

AI agents can be Proviso's customers. A buyer's agent drafts and opens a
contract; a worker's agent reads the tests, submits the work and reads the
verdict with its evidence and signed receipt; either one follows the money.
They do it through an MCP server (`/api/mcp`, or the stdio entry
`scripts/mcp-server.ts`) or the plain HTTP API (`docs/openapi.yaml`). The
role rules are the web app's: a token acts as one party, and the service
refuses what that party may not do.

Two steps stay with people:

| Step | Who | Why |
|---|---|---|
| Approving the PayPal payment (funding) | The payer, in PayPal's own window | No token can fund, whatever its scopes. The tool `get_funding_instructions` tells the agent what to ask the payer to do and where. |
| Signing a contract | Each party, on the contract page | Unless that party created its token with `--allow-sign`, delegating signing to its agent. |

## 1. Create a token

A token acts for one party. It is created on the machine that holds the
app's database (`data/clause.db`, or the file `CLAUSE_DB_PATH` names), and
printed once: only its SHA-256 is stored.

```bash
pnpm agent:token create --role payer --label "buyer agent"                 # read + write
pnpm agent:token create --role worker --allow-sign --label "worker agent"  # read + write + sign
pnpm agent:token create --role worker --read-only                          # read only
pnpm agent:token list
pnpm agent:token revoke <token id>
```

`pnpm agent:token` runs `tsx scripts/agent-token.ts` with `.env` loaded, so it
writes to the same database as `pnpm dev` and `pnpm start`. On a deployed
container, run `pnpm agent:token create ...` in the service's shell (the
database is on its volume).

| Scope | Granted | Allows |
|---|---|---|
| `read` | always | `whoami`, `list_contracts`, `get_contract`, `get_funding_instructions`, `get_verification`, `get_ledger`, `check_receipt`; `GET` routes |
| `write` | unless `--read-only` | everything the party may do except signing and funding: draft and create (payer), submit work (worker), re-run verification, open, argue, accept or decline a dispute |
| `sign` | only with `--allow-sign` | `sign_contract`, `POST /api/contracts/{id}/sign` |
| fund | never | `/fund/create-order` and `/fund/authorize` answer `403 FORBIDDEN` to every token |

A token that is malformed, unknown or revoked is refused with `401
UNAUTHORIZED`, never ignored. Without an `Authorization` header the HTTP API
behaves as before (the web app's "view as" cookie picks the party); the MCP
endpoint refuses any request without a token.

## 2. Connect

### Streamable HTTP (remote or local app)

The endpoint is `<app URL>/api/mcp` with `Authorization: Bearer <token>`. It
serves MCP clients of both protocol eras (2026-07-28 and 2025), statelessly.

Claude Code:

```bash
claude mcp add --transport http proviso http://localhost:3000/api/mcp \
  --header "Authorization: Bearer proviso_..."
```

A `.mcp.json` (Claude Code project config) or any client that reads the same
shape:

```json
{
  "mcpServers": {
    "proviso": {
      "type": "http",
      "url": "http://localhost:3000/api/mcp",
      "headers": { "Authorization": "Bearer proviso_..." }
    }
  }
}
```

### stdio (clients that launch a local process, e.g. Claude Desktop)

`scripts/mcp-server.ts` is a local MCP server that relays every call to a
running app's `/api/mcp` with the token, so the tools and their errors are
the app's. It imports only the MCP SDK, so it runs from any working
directory. Use absolute paths:

```json
{
  "mcpServers": {
    "proviso": {
      "command": "/path/to/proviso/node_modules/.bin/tsx",
      "args": ["/path/to/proviso/scripts/mcp-server.ts"],
      "env": {
        "PROVISO_URL": "http://localhost:3000",
        "PROVISO_TOKEN": "proviso_..."
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add proviso -e PROVISO_URL=http://localhost:3000 -e PROVISO_TOKEN=proviso_... \
  -- /path/to/proviso/node_modules/.bin/tsx /path/to/proviso/scripts/mcp-server.ts
```

At start it checks the token with `whoami` and logs to stderr, e.g.
`proviso mcp: relaying to http://localhost:3000/api/mcp as the worker
(scopes: read, write)`; an unreachable app or a refused token exits 1 with
the reason. Do not launch it through `pnpm run`: pnpm prints to stdout,
which carries the protocol.

### Plain HTTP

Every route in `docs/openapi.yaml` (served at `/api/openapi`) accepts the
same bearer token; the scope each operation needs is listed in its
`security`. `docs/api.md` has every rule in prose.

## 3. Tools

Every tool returns JSON as text. A failure is a tool result with `isError:
true` whose text is the HTTP API's error plus its status, e.g.
`{"error":{"code":"FORBIDDEN","message":"Only the payer can create a
contract..."},"http_status":403}`; codes are listed in `docs/api.md`. Inputs
are checked with the HTTP API's own schemas, so a bad input gets
`VALIDATION_ERROR` with `"<field>: <problem>"`. `get_contract` always says
what you may call now (`you_can_now`), what needs a person
(`needs_a_person`) and `next_step`.

| Tool | Who | Scope | What it does |
|---|---|---|---|
| `whoami` | either | read | The token's party, scopes and what it cannot do. |
| `list_contracts` | either | read | Every contract (optional `state` filter): id, title, state, amount, deadline, who signed, page URL. |
| `get_contract` | either | read | State, terms, `terms_sha256`, conditions with check params, drafter's notes, the latest verification with each check's outcome, reasoning and reviewer panel, dispute, money summary, latest signed receipt, allowed actions, `next_step`. |
| `draft_contract` | payer | write | Plain English to a proposed contract, or a refusal naming the conditions that cannot be checked. Creates nothing. |
| `create_contract` | payer | write | Creates a DRAFT contract from a draft (every term filled in). |
| `sign_contract` | either | sign | Signs as the token's party; both signatures make it SIGNED and fix the terms. |
| `get_funding_instructions` | either | read | What the payer must do to fund it and where (page URL, amount, steps). Never funds. |
| `submit_work` | worker | write | Submits a public URL (pull request or page); verification runs in the background. |
| `get_verification` | either | read | Run status; per condition outcome, confidence, reasoning, reviewer panel votes, evidence links; the signed receipt. |
| `rerun_verification` | either | write | Re-runs an inconclusive or crashed run (contract still VERIFYING). |
| `open_dispute` | either | write | Opens a dispute with your argument. |
| `respond_to_dispute` | either | write | Adds or revises your argument; once both argued, the AI mediator proposes a split. |
| `accept_proposal` | either | write | Accepts the split; when both accept, the money moves in that call. |
| `decline_proposal` | either | write | Declines the split; a person decides. |
| `get_ledger` | either | read | Every PayPal movement, totals, payout status and the latest failed money step. |
| `check_receipt` | either | read | Fetches a signed receipt and checks hash, Ed25519 signature, terms hash and each verdict's evidence. |

## 4. A worked example

This is what `scripts/agent-demo.ts` printed on 2026-11-12 against a local
app (scratch database, real drafter, real verifier, buyer over Streamable
HTTP, worker over stdio). Shortened; the payer's PayPal approval was
simulated (see below).

**Buyer's agent (payer token, `--allow-sign`)**

1. `draft_contract` with: *"I'll pay $25.00 USD for a one-page website at a
   public URL, delivered by 2026-11-15 23:59 UTC. It's done when: the page
   loads successfully; a paragraph on the page contains the words
   "documentation examples"; and the page explains to a visitor that the
   domain is meant for use as an example in documentation."* The drafter
   returned three conditions: `http_ok`; `dom_assert` on `p` containing
   "documentation examples"; and `ai_page_judgement` "Does the page state that
   the domain is intended to be used as an example in documentation?", with
   notes on how it read the deal.
2. `create_contract` with that draft: a DRAFT contract and its page URL.
3. `sign_contract`: "Signed as payer. Waiting for the other party to sign."

**Worker's agent (worker token, `--allow-sign`)**

4. `get_contract`: reads the three conditions and their check params before
   agreeing; `you_can_now: sign_contract`.
5. `sign_contract`: the contract is SIGNED.

**Buyer's agent**

6. `get_funding_instructions`: `can_be_funded_now: true`, 2500 cents USD, and
   for the payer:
   - **HUMAN STEP:** open the contract page, choose Payer in the header's
     view switch, click the PayPal button and approve the payment in
     PayPal's window. PayPal holds the amount; it is captured only when the
     work passes.

   (Asking for a funding tool anyway: `Tool fund_contract not found`.)

**Worker's agent**

7. `submit_work` with `https://example.com/`: contract VERIFYING.
8. `get_verification`, polled: `status passed`, contract PASSED, in 10 s.

**Buyer's agent**

9. `get_verification`: every check passed, each with its reasoning and an
   evidence screenshot link; the AI-judged check shows the reviewer panel:
   three reviewers (literal, worker_side, skeptic), each `pass` at 0.98,
   agreement 1.
10. `check_receipt`: `holds: true`; receipt hash, signing key, Ed25519
    signature, contract id, terms hash and all three verdicts match.
11. `get_ledger`: one AUTHORIZED row of 2500 and, in this demo,
    `last_failure: settle_pass/capture ... HTTP 404 RESOURCE_NOT_FOUND`,
    because the hold was simulated (in a real run the next rows are CAPTURED
    and PAID_OUT, and `payout.status` follows PayPal).

### Run the demo yourself

```bash
# 1. An app on a scratch database (never data/clause.db); next dev reads DeepSeek's key from .env
export CLAUSE_DB_PATH=/tmp/proviso-demo.db
pnpm exec tsx scripts/db-seed.ts --placeholder-identities
pnpm exec next dev -p 3400          # leave running; in a second terminal:

# 2. Both agents, same CLAUSE_DB_PATH
CLAUSE_DB_PATH=/tmp/proviso-demo.db pnpm exec tsx scripts/agent-demo.ts --app http://localhost:3400
```

If `pnpm dev` is already running in this directory, start the scratch app
from a copy of the tree instead: two dev servers in one directory share
`.next`.

The demo creates both tokens with `--allow-sign`, and stands in for the
payer's PayPal approval with the test-only fixture `scripts/flow-e2e.ts
fund`, which writes a made-up hold: no money is held, so the capture after a
pass fails at PayPal, as shown above. `--url <public URL>` submits another
page.

## 5. OpenAPI, SDKs and a docs portal with APIMatic

`docs/openapi.yaml` is an OpenAPI 3.1 description of the HTTP API, written
from the route handlers, served at `/api/openapi`. It validates with
`@seriousme/openapi-schema-validator` 2.11.0 (`valid: true`) and
`@redocly/cli` 2.77.0 `lint` (valid; 5 warnings, all "operation must have at
least one 4XX response" on routes that have none).

APIMatic turns it into SDKs and a documentation portal. This needs the
owner's APIMatic account; the steps below are from APIMatic's documentation
as of 2026-11-12. APIMatic's web dashboard is being retired and the CLI
replaces it for SDK and portal generation ([Web Dashboard
retirement](https://docs.apimatic.io/web-dashboard-retired/)).

1. Install the CLI and check it ([Installing the APIMatic
   CLI](https://docs.apimatic.io/apimatic-cli/intro-and-install/)):

   ```bash
   npm install -g @apimatic/cli@1
   apimatic --version
   ```

   That page pins major version 1. APIMatic's changelog says its generally
   available v4 C#, Python and TypeScript SDKs "are generated with version
   2.x of the APIMatic CLI" ([changelog, Sep 28
   2026](https://docs.apimatic.io/changelog/tags/cli/)); npm's `latest` for
   `@apimatic/cli` is 2.2.0 (Node.js >= 22.14). For v4 SDKs install
   `@apimatic/cli` without `@1`.

2. Sign in ([CLI getting
   started](https://docs.apimatic.io/apimatic-cli/getting-started)):

   ```bash
   apimatic auth login          # opens a browser; or: apimatic auth login --auth-key=<key>
   apimatic auth status         # shows the subscription and allowed SDK languages
   ```

3. Validate the file with APIMatic's own rules ([CLI
   commands](https://docs.apimatic.io/apimatic-cli/commands/)):

   ```bash
   apimatic api validate --file=docs/openapi.yaml
   ```

   or, once the app is deployed, `apimatic api validate
   --url=https://<your app>/api/openapi`.

4. Create the portal and SDK project in a new, empty directory ([Portal
   quickstart with Docs as
   Code](https://docs.apimatic.io/cli-getting-started/portal-quickstart-dac/)):

   ```bash
   mkdir proviso-portal && cd proviso-portal
   apimatic quickstart
   ```

   Choose "API Documentation Portal (Generate API docs + SDKs)", give it
   `docs/openapi.yaml` (or the `/api/openapi` URL) when it imports the API
   definition, and pick the SDK languages. It scaffolds the project (a `src`
   build directory: `APIMATIC-BUILD.json` and the spec under `spec/`, per
   [Contents of the build
   directory](https://docs.apimatic.io/docs-as-code/contents-of-the-build-directory/)),
   generates the portal and serves it at `http://localhost:3000`. Stop
   Proviso's own dev server first, or serve the portal on another port with
   `apimatic portal serve --port 3001`.

5. Regenerate after the API changes, from the directory that contains `src`
   ([CLI commands](https://docs.apimatic.io/apimatic-cli/commands/), [Generate
   SDKs through the
   CLI](https://docs.apimatic.io/generate-sdks/create-sdks/create-sdks-through-cli)):

   ```bash
   apimatic portal generate              # writes ./portal
   apimatic portal serve --open          # preview with hot reload
   apimatic sdk generate --language=typescript   # also csharp, java, php, python, ruby, go
   ```

   Run `apimatic sdk generate --help` first: flags differ between CLI
   versions (APIMatic's changelog records removed and added `sdk generate`
   flags in 2026). The generated portal is a static site in `portal/`.

What APIMatic will see: one bearer scheme (`agentToken`) with the scopes
listed per operation, the `clause_view_as` cookie as the web app's party
switch, the shared `Error` shape, and the `/api/mcp` endpoint described as a
JSON-RPC operation (point agents at MCP for it, not at a generated SDK
method).
