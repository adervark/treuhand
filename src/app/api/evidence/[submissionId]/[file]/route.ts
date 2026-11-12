import fs from "node:fs/promises";
import path from "node:path";
import { evidenceRoot } from "@/lib/verifier/evidence";
import { errorResponse, handle } from "../../../_lib/http";

/** The image types the verifier stores as evidence; nothing else is served. */
const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** One plain path segment: no separators, and no leading dot (so never "." or ".."). */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

const notFound = () => errorResponse("NOT_FOUND", "No evidence image at that path.");

/** True when `target` is inside `root` (both already resolved). */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * `GET /api/evidence/[submissionId]/[file]`: a screenshot the verifier stored
 * at `data/evidence/<submissionId>/<file>`. Reads only from the evidence
 * directory: a name that is not a plain file name is refused, and a path that
 * resolves outside the directory (e.g. through a symlink) is not found.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ submissionId: string; file: string }> },
): Promise<Response> {
  return handle(async () => {
    const { submissionId, file } = await ctx.params;
    if (!SEGMENT.test(submissionId) || !SEGMENT.test(file)) {
      return errorResponse("VALIDATION_ERROR", "file: not an evidence file name.");
    }
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!type) return notFound();

    let real: string;
    try {
      const root = await fs.realpath(evidenceRoot());
      real = await fs.realpath(path.join(root, submissionId, file));
      if (!isInside(root, real) || !(await fs.stat(real)).isFile()) return notFound();
    } catch {
      return notFound();
    }
    const body = await fs.readFile(real);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": type,
        "Content-Length": String(body.length),
        // File names carry a per-run stamp, so a stored image never changes.
        "Cache-Control": "private, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
