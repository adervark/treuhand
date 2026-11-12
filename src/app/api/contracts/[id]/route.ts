import { getContractDetail } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json } from "../../_lib/http";

/** `GET /api/contracts/[id]`: the ContractDetail for the current viewer. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(getContractDetail(id, await getViewerRole("read")));
  });
}
