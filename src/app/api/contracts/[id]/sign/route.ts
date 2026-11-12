import { signContract } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json } from "../../../_lib/http";

/** `POST /api/contracts/[id]/sign` (either party): signs as the viewer's party. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    return json({ contract: signContract(id, await getViewerRole("sign")) });
  });
}
