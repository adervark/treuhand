import { after } from "next/server";
import { rerunVerification } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json } from "../../../_lib/http";

/** `POST /api/contracts/[id]/verify` (either party): re-runs an inconclusive or crashed verification. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const job = rerunVerification(id, await getViewerRole());
    after(job.run);
    return json({ submissionId: job.submissionId }, 202);
  });
}
