import { answerProposal } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json, readJson } from "../../../../_lib/http";
import { AcceptBody } from "../../../../_lib/schemas";

/**
 * `POST /api/contracts/[id]/dispute/accept` (either party): accepts the
 * mediator's proposal, or declines it with `{ "accept": false }`. When both
 * have accepted, the split is settled in the same request.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = await readJson(request, AcceptBody);
    return json(await answerProposal(id, await getViewerRole(), body.accept));
  });
}
