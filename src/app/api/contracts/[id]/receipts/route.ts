import { getContractReceipts } from "@/lib/contract/service";
import { handle, json } from "../../../_lib/http";

/** `GET /api/contracts/[id]/receipts`: every signed verification receipt for the contract, newest first. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    return json(getContractReceipts(id));
  });
}
