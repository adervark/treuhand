import { describe, expect, it } from "vitest";
import { draftedDeadlineToLocalInput, isoToLocalInput } from "./format";

describe("draftedDeadlineToLocalInput", () => {
  it("starts a deadline drafted as a day at 23:59 of that day in the payer's zone", () => {
    expect(draftedDeadlineToLocalInput("2026-11-15T23:59:59.000Z")).toBe("2026-11-15T23:59");
  });

  it("shows a deadline drafted with a time in the payer's zone, and none as empty", () => {
    expect(draftedDeadlineToLocalInput("2026-11-15T11:30:00.000Z")).toBe(isoToLocalInput("2026-11-15T11:30:00.000Z"));
    expect(draftedDeadlineToLocalInput(null)).toBe("");
  });
});
