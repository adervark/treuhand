/**
 * The verifier's Ed25519 signing key for verification receipts.
 *
 * `VERIFIER_SIGNING_KEY` (a PKCS#8 PEM private key; `\n` escapes are read as
 * newlines) is used when set. Otherwise a key pair is generated on first use
 * and kept in `verifier-signing-key.pem` beside the database file (`data/` by
 * default, which git ignores), readable and writable by the owner only. With
 * an in-memory database the key is in memory too, and lives as long as the
 * process.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dbPath } from "@/lib/db/index";
import { publicKeyFingerprint, sha256Hex, SIGNATURE_ALGORITHM } from "./receipt-core";

export const KEY_FILE_NAME = "verifier-signing-key.pem";

export interface SigningKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  fingerprint: string;
  source: "env" | "file" | "memory";
}

let cached: { id: string; key: SigningKey } | null = null;

/** Where a generated key is kept, or null for an in-memory database. */
export function signingKeyFile(): string | null {
  const db = dbPath();
  return db === ":memory:" ? null : path.join(path.dirname(path.resolve(db)), KEY_FILE_NAME);
}

function fromPrivateKey(privateKey: KeyObject, source: SigningKey["source"], where: string): SigningKey {
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`${where} holds a ${privateKey.asymmetricKeyType} key; the verifier signs with Ed25519`);
  }
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, fingerprint: publicKeyFingerprint(publicKey), source };
}

function parsePem(pem: string, source: SigningKey["source"], where: string): SigningKey {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (error) {
    throw new Error(`${where} is not a PEM private key (${(error as Error).message})`);
  }
  return fromPrivateKey(privateKey, source, where);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Reads the key file, or creates it (atomically, owner-only) when there is none. */
function loadOrCreate(file: string): SigningKey {
  try {
    const pem = fs.readFileSync(file, "utf8");
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
    return parsePem(pem, "file", file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, pem, { mode: 0o600, flag: "wx" });
  try {
    // link() fails if the file exists, so two processes starting at once keep one key.
    fs.linkSync(temp, file);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    return parsePem(fs.readFileSync(file, "utf8"), "file", file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return fromPrivateKey(privateKey, "file", file);
}

export function getSigningKey(): SigningKey {
  const envPem = process.env.VERIFIER_SIGNING_KEY?.trim();
  const file = signingKeyFile();
  const id = envPem ? `env:${sha256Hex(envPem)}` : `file:${file ?? ":memory:"}`;
  if (cached?.id === id) return cached.key;
  const key = envPem
    ? parsePem(envPem.replace(/\\n/g, "\n"), "env", "VERIFIER_SIGNING_KEY")
    : file
      ? loadOrCreate(file)
      : fromPrivateKey(generateKeyPairSync("ed25519").privateKey, "memory", "the in-memory key");
  cached = { id, key };
  return key;
}

/** Ed25519 signature (base64) over the 32 bytes of a SHA-256 hex digest. */
export function signDigest(sha256HexDigest: string, key: SigningKey = getSigningKey()): string {
  return sign(null, Buffer.from(sha256HexDigest, "hex"), key.privateKey).toString("base64");
}

/** What `GET /api/verifier/public-key` returns. */
export interface VerifierPublicKey {
  algorithm: typeof SIGNATURE_ALGORITHM;
  /** SPKI PEM. */
  public_key_pem: string;
  /** The same key as a JWK (`kty: "OKP"`, `crv: "Ed25519"`, `x`). */
  public_key_jwk: { kty: string; crv: string; x: string };
  /** SHA-256 (hex) of the DER SPKI; receipts name the key that signed them by this. */
  fingerprint: string;
}

export function verifierPublicKey(key: SigningKey = getSigningKey()): VerifierPublicKey {
  const jwk = key.publicKey.export({ format: "jwk" });
  return {
    algorithm: SIGNATURE_ALGORITHM,
    public_key_pem: key.publicKey.export({ type: "spki", format: "pem" }) as string,
    public_key_jwk: { kty: String(jwk.kty), crv: String(jwk.crv), x: String(jwk.x) },
    fingerprint: key.fingerprint,
  };
}
