/**
 * Evidence files (screenshots) under `data/evidence/<submissionId>/`. Stored
 * paths are relative to the project root with forward slashes, e.g.
 * `data/evidence/<submissionId>/0-responsive-375px-lq3k2a.jpg`. File names
 * carry a per-run stamp, so a re-run never overwrites earlier evidence.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CheckContext } from "./index";

let rootOverride: string | null = null;

/** Test-only: write evidence under `dir` instead of `data/evidence`. */
export function setEvidenceRootForTests(dir: string | null): void {
  rootOverride = dir;
}

export function evidenceRoot(): string {
  return rootOverride ?? path.join(process.cwd(), "data", "evidence");
}

/** Absolute path of a stored evidence path. */
export function resolveEvidencePath(stored: string): string {
  return path.isAbsolute(stored) ? stored : path.join(/*turbopackIgnore: true*/ process.cwd(), stored);
}

function storedPath(absolute: string): string {
  const relative = path.relative(process.cwd(), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return absolute;
  return relative.split(path.sep).join("/");
}

const SAFE = /[^a-zA-Z0-9_-]+/g;

/** Writes one screenshot for this check and returns its stored path. */
export async function saveScreenshot(ctx: CheckContext, label: string, image: Buffer): Promise<string> {
  const dir = path.join(/*turbopackIgnore: true*/ evidenceRoot(), ctx.submission.id.replace(SAFE, "_"));
  await fs.mkdir(dir, { recursive: true });
  const stamp = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const name = `${ctx.condition.position}-${ctx.condition.check_kind}-${label.replace(SAFE, "_")}-${stamp}.jpg`;
  const file = path.join(dir, name);
  await fs.writeFile(file, image);
  return storedPath(file);
}
