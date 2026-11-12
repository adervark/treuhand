/**
 * A tiny HTTP server for the verifier's fixture pages (test/fixtures/site).
 * Used by the vitest suites and scripts/verifier-eval.ts. Listens on
 * 127.0.0.1, so callers must enable the verifier's test-only private-network
 * flag (`unsafeAllowPrivateNetworkForTests(true)`).
 *
 * Routes besides the static files:
 *   POST /api/contact          200 {"ok":true}   (the good form's endpoint)
 *   POST /api/contact-broken   500               (the broken form's endpoint)
 *   GET  /status/<code>        that status code
 *   GET  /redirect             302 -> /good.html
 *   GET  /reset                destroys the connection (a transient network failure)
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export const FIXTURE_SITE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "site");

export interface FixtureServer {
  /** e.g. http://127.0.0.1:40123 */
  url: string;
  /** Requests received, as "METHOD /path". */
  requests: string[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8" };

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    requests.push(`${req.method} ${url.pathname}`);

    if (req.method === "POST") {
      req.resume();
      req.on("end", () => {
        if (url.pathname === "/api/contact") res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        else res.writeHead(500, { "content-type": "application/json" }).end('{"ok":false}');
      });
      return;
    }
    if (url.pathname === "/reset") {
      req.socket.destroy();
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/good.html" }).end();
      return;
    }
    const status = /^\/status\/(\d{3})$/.exec(url.pathname);
    if (status) {
      res.writeHead(Number(status[1]), { "content-type": "text/html" }).end(`<h1>Status ${status[1]}</h1>`);
      return;
    }
    const file = path.normalize(path.join(FIXTURE_SITE_DIR, url.pathname === "/" ? "good.html" : url.pathname));
    if (!file.startsWith(FIXTURE_SITE_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
