import { describe, expect, it } from "bun:test";

const { permissionFlags } = await import("../index.js");

describe("codex permissionFlags", () => {
  it("plan → read-only sandbox + untrusted approval", () => {
    expect(permissionFlags("plan")).toEqual([
      "-a",
      "untrusted",
      "--sandbox",
      "read-only",
    ]);
  });

  it("acceptEdits → workspace-write", () => {
    expect(permissionFlags("acceptEdits")).toEqual([
      "-a",
      "on-request",
      "--sandbox",
      "workspace-write",
    ]);
  });

  it("fullAuto → never-ask + workspace-write (stable expansion of --full-auto)", () => {
    expect(permissionFlags("fullAuto")).toEqual([
      "-a",
      "never",
      "--sandbox",
      "workspace-write",
    ]);
  });

  it("undefined / unknown → acceptEdits (never most-permissive)", () => {
    expect(permissionFlags(undefined)).toEqual([
      "-a",
      "on-request",
      "--sandbox",
      "workspace-write",
    ]);
    expect(permissionFlags("bogus" as never)).toEqual([
      "-a",
      "on-request",
      "--sandbox",
      "workspace-write",
    ]);
  });
});
