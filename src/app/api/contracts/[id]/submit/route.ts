import { after } from "next/server";
import { submitWork } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json, readJson } from "../../../_lib/http";
import { SubmitBody } from "../../../_lib/schemas";

/**
 * `POST /api/contracts/[id]/submit` (worker only): records the submission and
 * answers 202 with the contract already VERIFYING; the verifier runs after the
 * response and records its outcome (or its crash) on the contract.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = await readJson(request, SubmitBody);
    const job = submitWork(id, await getViewerRole(), body.url);
    after(job.run);
    return json({ submissionId: job.submissionId }, 202);
  });
}
