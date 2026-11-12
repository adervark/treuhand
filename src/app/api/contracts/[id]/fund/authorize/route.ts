import { confirmFunding } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json, readJson } from "../../../../_lib/http";
import { AuthorizeBody } from "../../../../_lib/schemas";

/** `POST /api/contracts/[id]/fund/authorize` (payer only): authorizes the approved order; the contract becomes FUNDED. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = await readJson(request, AuthorizeBody);
    return json({ contract: await confirmFunding(id, await getViewerRole("fund"), body.orderId) });
  });
}
