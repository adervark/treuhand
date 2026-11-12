import { editContractConditions } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json, readJson } from "../../../_lib/http";
import { EditConditionsBody } from "../../../_lib/schemas";

/** `PATCH /api/contracts/[id]/conditions` (either party, DRAFT only): replaces the conditions, clears sign-offs. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = await readJson(request, EditConditionsBody);
    return json(editContractConditions(id, await getViewerRole(), body.conditions));
  });
}
