import { listLedger } from "@/lib/contract/service";
import { handle, json } from "../_lib/http";

/** `GET /api/ledger`: every ledger entry, oldest first, with its contract's title, state and currency. */
export async function GET(): Promise<Response> {
  return handle(() => json({ entries: listLedger() }));
}
