import { describe, expect, it } from "bun:test";

const { permissionFlags } = await import("../index.js");

describe("codex permissionFlags", () => {
  it("plan → read-only sandbox", () => {
    expect(permissionFlags("plan")).toEqual(["--sandbox", "read-only"]);
  });

  it("acceptEdits → workspace-write sandbox", () => {
    expect(permissionFlags("acceptEdits")).toEqual([
      "--sandbox",
      "workspace-write",
    ]);
  });

  it("fullAuto → bypass approvals and sandbox (safe inside the vibe sandbox)", () => {
    expect(permissionFlags("fullAuto")).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("undefined / unknown → workspace-write (never most-permissive)", () => {
    expect(permissionFlags(undefined)).toEqual([
      "--sandbox",
      "workspace-write",
    ]);
    expect(permissionFlags("bogus" as never)).toEqual([
      "--sandbox",
      "workspace-write",
    ]);
  });
});
