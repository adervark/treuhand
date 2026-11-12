import { runSweep } from "@/lib/contract/service";
import { handle, json } from "../_lib/http";

/** `POST /api/sweep` (no party): expires, settles and retries what is due. */
export async function POST(): Promise<Response> {
  return handle(async () => json(await runSweep()));
}
