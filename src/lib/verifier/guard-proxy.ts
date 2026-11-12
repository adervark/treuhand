/**
 * A local forward proxy that every byte the verifier's browser sends goes
 * through. Chromium does not route redirect hops or WebSocket upgrades through
 * Playwright's request interception, so interception alone cannot keep a page
 * from redirecting the verifier into a private network; a proxy sees every
 * connection (navigations, redirects, subresources, form posts, sockets).
 *
 * For each connection the target host is resolved and checked with
 * `resolvePublicHost`, and the proxy connects to exactly that address.
 * Refused and failed targets are logged so a check can explain a failed load.
 */
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { BlockedTargetError, HostNotFoundError, resolvePublicHost } from "./net-guard";

const UPSTREAM_TIMEOUT_MS = 20_000;
const HOP_BY_HOP = ["proxy-connection", "proxy-authorization", "connection", "keep-alive", "te", "trailer", "upgrade"];

export interface ProxyLogEntry {
  target: string;
  host: string;
  outcome: "blocked" | "not_found" | "error";
  reason: string;
}

export interface GuardProxy {
  /** e.g. http://127.0.0.1:41234, for Playwright's `proxy.server`. */
  url: string;
  /** Targets that were refused or could not be reached, in order. */
  log: ProxyLogEntry[];
  close(): Promise<void>;
}

function splitHostPort(authority: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1].replace(/^\[|\]$/g, ""), port };
}

function describeFailure(error: unknown): Omit<ProxyLogEntry, "target" | "host"> {
  if (error instanceof BlockedTargetError) return { outcome: "blocked", reason: error.message };
  if (error instanceof HostNotFoundError) return { outcome: "not_found", reason: error.message };
  const err = error as NodeJS.ErrnoException;
  return { outcome: "error", reason: err.code ? `${err.code}: ${err.message}` : String(err.message ?? error) };
}

export async function startGuardProxy(): Promise<GuardProxy> {
  const log: ProxyLogEntry[] = [];
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  const server = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
      if (target.protocol !== "http:") throw new Error("not an absolute http URL");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("Proviso verifier proxy: bad request");
      return;
    }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    resolvePublicHost(host).then(
      ([address]) => {
        const headers = { ...req.headers };
        for (const name of HOP_BY_HOP) delete headers[name];
        const upstream = http.request(
          {
            host: address.address,
            family: address.family,
            port: target.port || 80,
            method: req.method,
            path: target.pathname + target.search,
            headers,
            timeout: UPSTREAM_TIMEOUT_MS,
          },
          (upstreamRes) => {
            const outHeaders = { ...upstreamRes.headers };
            for (const name of HOP_BY_HOP) delete outHeaders[name];
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, outHeaders);
            upstreamRes.pipe(res);
          },
        );
        upstream.on("timeout", () => upstream.destroy(new Error("upstream timed out")));
        upstream.on("error", (error) => {
          log.push({ target: target.href, host, ...describeFailure(error) });
          if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
          res.end("Proviso verifier proxy: upstream error");
        });
        req.pipe(upstream);
      },
      (error: unknown) => {
        const failure = describeFailure(error);
        log.push({ target: target.href, host, ...failure });
        res
          .writeHead(failure.outcome === "blocked" ? 403 : 502, {
            "content-type": "text/plain",
            "x-clause-proxy": failure.outcome,
          })
          .end(`Proviso verifier proxy refused this request: ${failure.reason}`);
      },
    );
  });

  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on("error", () => client.destroy());
    const authority = req.url ?? "";
    const parsed = splitHostPort(authority);
    if (!parsed) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    resolvePublicHost(parsed.host).then(
      ([address]) => {
        const upstream = net.connect({ host: address.address, port: parsed.port, family: address.family });
        track(upstream);
        upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error("upstream timed out")));
        upstream.once("connect", () => {
          upstream.setTimeout(0);
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("error", (error) => {
          log.push({ target: authority, host: parsed.host, ...describeFailure(error) });
          if (client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          else client.destroy();
        });
        client.on("close", () => upstream.destroy());
      },
      (error: unknown) => {
        const failure = describeFailure(error);
        log.push({ target: authority, host: parsed.host, ...failure });
        client.end(`HTTP/1.1 ${failure.outcome === "blocked" ? "403 Forbidden" : "502 Bad Gateway"}\r\n\r\n`);
      },
    );
  });
  server.on("connection", track);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as net.AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
