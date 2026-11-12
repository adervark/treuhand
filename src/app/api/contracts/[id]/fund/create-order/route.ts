import { createFundingOrder } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json } from "../../../../_lib/http";

/** `POST /api/contracts/[id]/fund/create-order` (payer only, SIGNED): a PayPal AUTHORIZE order for the button. */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    return json({ orderId: await createFundingOrder(id, await getViewerRole("fund")) });
  });
}
