/**
 * The acting party from the view-as cookie, and the stale-tab guard (DEF-20):
 * a write that names, in X-Treuhand-Role, a role other than the cookie's is
 * refused, because another tab of the same browser switched the role.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/contract/service-errors";

const request = vi.hoisted(() => ({ cookie: undefined as string | undefined, headers: new Headers() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "clause_view_as" && request.cookie ? { value: request.cookie } : undefined) }),
  headers: async () => request.headers,
}));

const { getViewerRole, PAGE_ROLE_HEADER } = await import("./viewer");

beforeEach(() => {
  request.cookie = undefined;
  request.headers = new Headers();
});

describe("getViewerRole", () => {
  it("reads the cookie, payer by default", async () => {
    expect(await getViewerRole()).toBe("payer");
    request.cookie = "worker";
    expect(await getViewerRole()).toBe("worker");
    request.cookie = "admin";
    expect(await getViewerRole()).toBe("payer");
  });

  it("accepts a write whose page role matches the cookie, or that sends none", async () => {
    request.cookie = "worker";
    request.headers.set(PAGE_ROLE_HEADER, "worker");
    expect(await getViewerRole("sign")).toBe("worker");
    request.headers.delete(PAGE_ROLE_HEADER);
    expect(await getViewerRole("write")).toBe("worker");
  });

  it("refuses a write from a page still showing the other role (ROLE_MISMATCH)", async () => {
    request.cookie = "worker";
    request.headers.set(PAGE_ROLE_HEADER, "payer");
    for (const need of ["write", "sign", "fund"] as const) {
      const err = await getViewerRole(need).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe("ROLE_MISMATCH");
      expect((err as ServiceError).message).toMatch(/switched to the worker in another tab.*still showing the payer/);
    }
    // The missing cookie is the payer, so a page showing the worker is stale too.
    request.cookie = undefined;
    request.headers.set(PAGE_ROLE_HEADER, "worker");
    await expect(getViewerRole()).rejects.toMatchObject({ code: "ROLE_MISMATCH" });
  });

  it("answers reads with the cookie's role, and ignores an unknown page role", async () => {
    request.cookie = "worker";
    request.headers.set(PAGE_ROLE_HEADER, "payer");
    expect(await getViewerRole("read")).toBe("worker");
    request.headers.set(PAGE_ROLE_HEADER, "admin");
    expect(await getViewerRole("write")).toBe("worker");
  });
});
