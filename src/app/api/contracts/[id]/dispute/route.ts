import { openDispute } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json, readJson } from "../../../_lib/http";
import { ArgumentBody } from "../../../_lib/schemas";

/** `POST /api/contracts/[id]/dispute` (either party): opens a dispute with the viewer's argument. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = await readJson(request, ArgumentBody);
    return json({ dispute: openDispute(id, await getViewerRole(), body.argument) });
  });
}
