import { draftFromPrompt } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json, readJson } from "../../_lib/http";
import { DraftBody } from "../../_lib/schemas";

/** `POST /api/contracts/draft` (payer only): the drafter's DraftResult, unchanged. */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const body = await readJson(request, DraftBody);
    return json(await draftFromPrompt(await getViewerRole(), body.prompt, body.type));
  });
}
