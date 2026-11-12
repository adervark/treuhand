/** The network guard and guard proxy, with the private-network flag off (production behaviour). */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkContext } from "../../../test/fixtures/context";
import { startGuardProxy } from "./guard-proxy";
import { assertAllowedUrl, BlockedTargetError, isPrivateAddress, resolvePublicHost, unsafeAllowPrivateNetworkForTests } from "./net-guard";
import { checkDomAssert, checkHttpOk } from "./website";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.8.9.10",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "[::1]",
  ])("refuses %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it("refuses things that are not addresses", () => {
    expect(isPrivateAddress("example.com")).toBe(true);
  });
});

describe("assertAllowedUrl", () => {
  it("allows public http and https URLs", () => {
    expect(assertAllowedUrl("https://example.com/a?b=1").hostname).toBe("example.com");
    expect(assertAllowedUrl("http://93.184.215.14/").hostname).toBe("93.184.215.14");
  });

  it.each([
    ["file:///etc/passwd", /http and https/],
    ["javascript:alert(1)", /http and https/],
    ["ftp://example.com/", /http and https/],
    ["https://user:pw@example.com/", /credentials/],
    ["http://localhost:3000/", /local host name/],
    ["http://app.localhost/", /local host name/],
    ["http://printer.local/", /local host name/],
    ["http://intranet/", /local host name/],
    ["http://127.0.0.1:3000/api", /private/],
    ["http://[::1]/", /private/],
    ["http://169.254.169.254/latest/meta-data/", /private/],
    ["not a url", /not a valid URL/],
  ])("refuses %s", (url, message) => {
    expect(() => assertAllowedUrl(url)).toThrow(message);
  });
});

describe("resolvePublicHost", () => {
  it("refuses names and literals that resolve to private addresses", async () => {
    await expect(resolvePublicHost("localhost")).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(resolvePublicHost("127.0.0.1")).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(resolvePublicHost("::ffff:127.0.0.1")).rejects.toBeInstanceOf(BlockedTargetError);
  });
});

describe("unsafeAllowPrivateNetworkForTests", () => {
  it("refuses to turn on in production", () => {
    const previous = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect(() => unsafeAllowPrivateNetworkForTests(true)).toThrow(/production/);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = previous ?? "test";
    }
  });
});

describe("with the flag off", () => {
  let target: http.Server;
  let targetUrl: string;
  const hits: string[] = [];

  beforeAll(async () => {
    unsafeAllowPrivateNetworkForTests(false);
    target = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/html" }).end("<h1>internal admin</h1>");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it("the proxy refuses plain-HTTP and CONNECT requests to loopback", async () => {
    const proxy = await startGuardProxy();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(proxy.url + "/", { path: `${targetUrl}/secret`, headers: { host: new URL(targetUrl).host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);

      const connectStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(proxy.url, { method: "CONNECT", path: "169.254.169.254:80" });
        req.on("connect", (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect(connectStatus).toBe(403);
      expect(proxy.log.map((e) => e.outcome)).toEqual(["blocked", "blocked"]);
      expect(hits).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it("checks refuse a submission on loopback without visiting it", async () => {
    const http_ok = await checkHttpOk(checkContext("http_ok", {}, `${targetUrl}/secret`));
    expect(http_ok).toMatchObject({ passed: false, confidence: 1 });
    expect(http_ok.reasoning).toMatch(/refuses|will not visit/);

    const dom = await checkDomAssert(checkContext("dom_assert", { selector: "h1" }, `${targetUrl}/secret`));
    expect(dom).toMatchObject({ passed: false, confidence: 1 });
    expect(dom.reasoning).toMatch(/will not visit/);
    expect(hits).toEqual([]);
  });
});
