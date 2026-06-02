/**
 * vibe-plugin-ai-codex credential-resolution tests
 *
 * Verifies the provider resolves OPENAI_API_KEY from the agent config bag
 * (`hostServices.getConfig`) when it is NOT present in process.env — the path
 * the frontend writes to (PUT /api/config/OPENAI_API_KEY) — and that the codex
 * `exec` sandbox permission flags are correct.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { HostServices } from "@vibecontrols/plugin-sdk";

// Stub the openai SDK so constructing a client never touches the network.
// The provider reads `mod.default ?? mod`, so the stub is the default export.
mock.module("openai", () => {
  class MockOpenAI {
    constructor(_opts: { apiKey: string }) {
      // no-op stub
    }
  }
  return { default: MockOpenAI };
});

const { createPlugin, permissionFlags } = await import("../index.js");

/**
 * `AIAgentProvider` does not surface the optional `setHostServices` lifecycle
 * method, but the concrete provider class implements it. Narrow to a structural
 * type that exposes the methods the tests drive.
 */
interface ProviderWithHost {
  setHostServices(hs: HostServices): void;
  setMode(mode: "sdk" | "cli"): void;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

function getProvider(): ProviderWithHost {
  const plugin = createPlugin({ name: "test", dataDir: "/tmp" });
  return plugin.providers!.ai! as unknown as ProviderWithHost;
}

/**
 * The plugin exports a single shared provider instance, so credential state
 * (the warmed `cachedApiKey`, the resolved mode, and the cached adapter/client)
 * leaks between tests. Reset those private fields so each test starts from a
 * cold resolve and genuinely exercises the env → cache → config-bag chain.
 */
function resetProviderState(provider: ProviderWithHost): void {
  const internal = provider as unknown as Record<string, unknown>;
  internal["cachedApiKey"] = undefined;
  internal["hostServices"] = null;
  internal["adapter"] = null;
  internal["activeMode"] = null;
}

function makeHostServices(
  configKey: string | null,
  configValue: string | undefined,
): { hs: HostServices; getConfig: ReturnType<typeof mock> } {
  const getConfig = mock((key: string): Promise<string | undefined> => {
    if (configKey !== null && key === configKey) {
      return Promise.resolve(configValue);
    }
    return Promise.resolve(undefined);
  });
  const hs: HostServices = {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    getConfig,
  };
  return { hs, getConfig };
}

describe("codex credential resolution", () => {
  beforeEach(() => {
    delete process.env["OPENAI_API_KEY"];
    resetProviderState(getProvider());
  });

  it("resolves the key from the config bag (env cleared) and healthCheck is ok", async () => {
    const provider = getProvider();
    const { hs, getConfig } = makeHostServices(
      "OPENAI_API_KEY",
      "cfg-openai-key",
    );

    provider.setHostServices(hs);
    await new Promise((r) => setTimeout(r, 0));
    provider.setMode("sdk");

    const result = await provider.healthCheck();
    expect(result.ok).toBe(true);
    expect(getConfig).toHaveBeenCalled();
  });

  it("reports ok:false with a /required/ message (not /Failed to load openai/) when no key is available", async () => {
    const provider = getProvider();
    const { hs } = makeHostServices(null, undefined);

    provider.setHostServices(hs);
    await new Promise((r) => setTimeout(r, 0));
    provider.setMode("sdk");

    const result = await provider.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/required/i);
    expect(result.message).not.toMatch(/Failed to load openai/i);
  });
});

describe("codex permissionFlags (exec sandbox flags)", () => {
  it("fullAuto bypasses approvals and sandbox", () => {
    const flags = permissionFlags("fullAuto");
    expect(flags).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("plan → read-only sandbox", () => {
    expect(permissionFlags("plan")).toEqual(["--sandbox", "read-only"]);
  });

  it("acceptEdits → workspace-write sandbox", () => {
    expect(permissionFlags("acceptEdits")).toEqual([
      "--sandbox",
      "workspace-write",
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

  it("never emits the legacy --quiet flag for any mode", () => {
    expect(permissionFlags("fullAuto")).not.toContain("--quiet");
    expect(permissionFlags("plan")).not.toContain("--quiet");
    expect(permissionFlags("acceptEdits")).not.toContain("--quiet");
    expect(permissionFlags(undefined)).not.toContain("--quiet");
  });
});
