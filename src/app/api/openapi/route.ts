import fs from "node:fs/promises";
import path from "node:path";
import { errorResponse, handle } from "../_lib/http";

// Read from disk per request, so the served file is always docs/openapi.yaml as deployed.
export const dynamic = "force-dynamic";

/** `GET /api/openapi`: the OpenAPI 3.1 description of this API (docs/openapi.yaml). */
export async function GET(): Promise<Response> {
  return handle(async () => {
    let body: string;
    try {
      body = await fs.readFile(path.join(process.cwd(), "docs", "openapi.yaml"), "utf8");
    } catch {
      return errorResponse("NOT_FOUND", "docs/openapi.yaml is not deployed with this app.");
    }
    return new Response(body, { headers: { "Content-Type": "application/yaml; charset=utf-8" } });
  });
}
