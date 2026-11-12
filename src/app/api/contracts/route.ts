import { createFromProposal, listAllContracts } from "@/lib/contract/service";
import { getViewerRole } from "@/lib/viewer";
import { handle, json, readJson } from "../_lib/http";
import { CreateContractBody } from "../_lib/schemas";

/** `GET /api/contracts`: every contract, newest first. */
export async function GET(): Promise<Response> {
  return handle(() => json({ contracts: listAllContracts() }));
}

/** `POST /api/contracts` (payer only): a proposed contract in, a DRAFT contract out. */
export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const body = await readJson(request, CreateContractBody);
    const contract = createFromProposal(await getViewerRole(), body);
    return json({ contract }, 201);
  });
}
