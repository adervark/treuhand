import { verifierPublicKey } from "@/lib/verifier/signing-key";
import { handle, json } from "../../_lib/http";

// The key belongs to the running instance (its env or data directory), never to the build.
export const dynamic = "force-dynamic";

/** `GET /api/verifier/public-key`: the key that signs verification receipts, and its fingerprint. */
export async function GET(): Promise<Response> {
  return handle(() => json(verifierPublicKey()));
}
