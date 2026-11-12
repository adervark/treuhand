/**
 * Checks Proviso verification receipts independently of the app's database:
 * recomputes each receipt's hash from its content, checks the Ed25519
 * signature against the verifier's public key, and, given the contract,
 * recomputes the agreed-terms hash and compares each verdict's evidence and
 * reasoning with the hashes the receipt signed. With an app URL it also
 * downloads each screenshot and compares its hash. The rules are in
 * src/lib/verifier/receipt-core.ts, which needs only node:crypto.
 *
 *   pnpm exec tsx scripts/verify-receipt.ts <receipt> [--key <pem>] [--contract <contract>] [--app <url>] [--no-screenshots]
 *
 * <receipt>   a file or URL holding one receipt, `{ "receipts": [...] }` (GET /api/contracts/<id>/receipts),
 *             or a contract detail with its latest `receipt` (GET /api/contracts/<id>, also used as the contract)
 * --key       the public key: a PEM file, or a URL answering PEM or `{ "public_key_pem": ... }`;
 *             defaults to <app>/api/verifier/public-key
 * --contract  the contract JSON (file or URL, the shape GET /api/contracts/<id> answers);
 *             defaults to <app>/api/contracts/<contract_id> when --app is given
 * --app       the app's base URL, e.g. http://localhost:3000
 *
 * Exits 0 when every receipt holds, 1 when any check fails, 2 on a usage or fetch error.
 */
import { readFileSync } from "node:fs";
import {
  checkReceipt,
  receiptHolds,
  sha256Hex,
  type ContractEvidence,
  type ReceiptCheck,
  type SignedReceipt,
} from "../src/lib/verifier/receipt-core";

class UsageError extends Error {}

interface Options {
  receipt: string;
  key?: string;
  contract?: string;
  app?: string;
  screenshots: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = { screenshots: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    if (arg === "--key") options.key = value();
    else if (arg === "--contract") options.contract = value();
    else if (arg === "--app") options.app = value().replace(/\/+$/, "");
    else if (arg === "--no-screenshots") options.screenshots = false;
    else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
    else if (!options.receipt) options.receipt = arg;
    else throw new UsageError(`unexpected argument ${arg}`);
  }
  if (!options.receipt) throw new UsageError("name a receipt file or URL");
  if (!options.key && !options.app) throw new UsageError("give the public key with --key, or the app URL with --app");
  return options as Options;
}

const isUrl = (source: string) => /^https?:\/\//i.test(source);

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { accept: "application/json, application/x-pem-file, */*" } });
  if (!response.ok) throw new UsageError(`GET ${url} answered HTTP ${response.status}`);
  return response;
}

async function readText(source: string): Promise<string> {
  return isUrl(source) ? (await fetchOk(source)).text() : readFileSync(source, "utf8");
}

async function readJson(source: string): Promise<unknown> {
  const text = await readText(source);
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${source} is not JSON`);
  }
}

async function readPublicKey(source: string): Promise<string> {
  const text = (await readText(source)).trim();
  if (text.startsWith("-----BEGIN")) return text;
  try {
    const pem = (JSON.parse(text) as { public_key_pem?: unknown }).public_key_pem;
    if (typeof pem === "string") return pem;
  } catch {
    // fall through
  }
  throw new UsageError(`${source} holds neither a PEM public key nor { "public_key_pem": ... }`);
}

/** The receipts in a source, and the contract detail when the source is one. */
function receiptsIn(data: unknown): { receipts: unknown[]; contract?: ContractEvidence } {
  const obj = (data ?? {}) as Record<string, unknown>;
  if (typeof obj.receipt_sha256 === "string") return { receipts: [obj] };
  if (Array.isArray(obj.receipts)) return { receipts: obj.receipts };
  if (obj.contract && "receipt" in obj) {
    return { receipts: obj.receipt ? [obj.receipt] : [], contract: obj as unknown as ContractEvidence };
  }
  throw new UsageError("the receipt source holds no receipt");
}

/** Downloads each screenshot the receipt names and compares its hash. */
async function screenshotChecks(signed: SignedReceipt, app: string): Promise<ReceiptCheck[]> {
  const checks: ReceiptCheck[] = [];
  for (const [i, verdict] of signed.receipt.verdicts.entries()) {
    for (const shot of verdict.screenshots ?? []) {
      const check = `screenshot of verdict ${i + 1}`;
      const match = /^data\/evidence\/([^/]+)\/([^/]+)$/.exec(shot.path);
      if (!match || shot.sha256 === null) {
        checks.push({ check, ok: null, detail: `${shot.path}: ${match ? "missing when the receipt was issued" : "not an evidence path"}; not compared` });
        continue;
      }
      const url = `${app}/api/evidence/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`;
      const response = await fetch(url);
      if (!response.ok) {
        checks.push({ check, ok: false, detail: `${url} answered HTTP ${response.status}` });
        continue;
      }
      const hash = sha256Hex(new Uint8Array(await response.arrayBuffer()));
      checks.push({ check, ok: hash === shot.sha256, detail: hash === shot.sha256 ? `${match[2]} matches` : `${match[2]} hashes to ${hash}, receipt says ${shot.sha256}` });
    }
  }
  return checks;
}

const MARK = { true: "ok  ", false: "FAIL", null: "skip" } as const;

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const publicKeyPem = await readPublicKey(options.key ?? `${options.app}/api/verifier/public-key`);
  const source = receiptsIn(await readJson(options.receipt));
  if (source.receipts.length === 0) throw new UsageError("the receipt source holds no receipt");
  const given = options.contract ? ((await readJson(options.contract)) as ContractEvidence) : source.contract;
  const contracts = new Map<string, ContractEvidence>();

  let holds = true;
  for (const receipt of source.receipts) {
    const id = (receipt as Partial<SignedReceipt>).receipt?.contract_id;
    let contract = given;
    if (!contract && options.app && typeof id === "string") {
      if (!contracts.has(id)) contracts.set(id, (await readJson(`${options.app}/api/contracts/${encodeURIComponent(id)}`)) as ContractEvidence);
      contract = contracts.get(id);
    }
    const checks = checkReceipt(receipt, publicKeyPem, contract);
    if (!contract) checks.push({ check: "terms hash", ok: null, detail: "no contract JSON given (--contract or --app); not compared" });
    if (options.app && options.screenshots && checks[0].check !== "receipt format") {
      checks.push(...(await screenshotChecks(receipt as SignedReceipt, options.app)));
    }
    const signed = receipt as Partial<SignedReceipt>;
    const r = signed.receipt;
    console.log(
      `\nReceipt ${signed.receipt_sha256 ?? "(no hash)"}` +
        (r ? `\n  contract ${r.contract_id}, submission ${r.submission_id}, outcome ${r.outcome}, issued ${r.issued_at}` : ""),
    );
    const width = Math.max(...checks.map((c) => c.check.length));
    for (const c of checks) console.log(`  ${MARK[String(c.ok) as keyof typeof MARK]}  ${c.check.padEnd(width)}  ${c.detail}`);
    const ok = receiptHolds(checks);
    console.log(`  => ${ok ? "HOLDS" : "DOES NOT HOLD"}`);
    holds &&= ok;
  }
  console.log(`\n${source.receipts.length} receipt(s): ${holds ? "every receipt holds" : "at least one receipt does NOT hold"}.`);
  return holds ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof UsageError ? `verify-receipt: ${error.message}` : error);
    process.exitCode = 2;
  },
);
