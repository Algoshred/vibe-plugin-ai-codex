/**
 * vibe-plugin-ai-codex SDK streaming tests
 *
 * The openai SDK's `responses.create({ stream: true })` returns a promise that
 * resolves to the event stream; the promise itself is not async-iterable. These
 * tests drive the provider's SDK adapter with a client that behaves exactly
 * like that, so iterating the un-awaited promise fails the test.
 */
import { afterEach, describe, expect, it } from "bun:test";

const { createPlugin } = await import("../index.js");

interface StreamEvent {
  type: string;
  delta?: string;
  response?: unknown;
}

interface ChunkLike {
  type: string;
  content: string;
}

interface ProviderUnderTest {
  setMode(mode: "sdk" | "cli"): void;
  createSession(config: {
    name: string;
    agentType: string;
    model?: string;
    systemPrompt?: string;
    maxTokens?: number;
  }): Promise<{ id: string }>;
  streamPrompt(
    sessionId: string,
    prompt: string,
    context?: unknown[],
    onChunk?: (chunk: ChunkLike) => void,
  ): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>;
  sendPrompt(
    sessionId: string,
    prompt: string,
  ): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

const completedResponse = {
  id: "resp_1",
  model: "gpt-5-codex",
  output: [
    { type: "message", content: [{ type: "output_text", text: "hello" }] },
  ],
  usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
};

async function* events(list: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of list) {
    yield event;
  }
}

/**
 * A client shaped like the real SDK: `create` returns a plain Promise (not an
 * async iterable), resolving to the stream when `stream: true` is passed.
 */
function makeFakeClient(calls: Array<Record<string, unknown>>): unknown {
  return {
    responses: {
      create(params: Record<string, unknown>): Promise<unknown> {
        calls.push(params);
        if (params["stream"] === true) {
          return Promise.resolve(
            events([
              { type: "response.output_text.delta", delta: "hel" },
              { type: "response.output_text.delta", delta: "lo" },
              { type: "response.completed", response: completedResponse },
            ]),
          );
        }
        return Promise.resolve(completedResponse);
      },
    },
  };
}

function setUp(calls: Array<Record<string, unknown>>): ProviderUnderTest {
  process.env["OPENAI_API_KEY"] = "sk-test";
  const plugin = createPlugin({ name: "test", dataDir: "/tmp" });
  const provider = plugin.providers!.ai! as unknown as ProviderUnderTest;
  provider.setMode("sdk");
  // Build the SDK adapter through the provider, then swap in the fake client
  // so no network or real SDK is involved.
  const internal = provider as unknown as {
    getAdapter(): Record<string, unknown>;
  };
  const adapter = internal.getAdapter();
  adapter["client"] = makeFakeClient(calls);
  return provider;
}

describe("codex SDK adapter", () => {
  afterEach(() => {
    delete process.env["OPENAI_API_KEY"];
  });

  it("awaits the stream before iterating and forwards text deltas", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = setUp(calls);
    const session = await provider.createSession({
      name: "stream",
      agentType: "codex",
      systemPrompt: "be brief",
      maxTokens: 32,
    });

    const chunks: ChunkLike[] = [];
    const result = await provider.streamPrompt(
      session.id,
      "hi",
      undefined,
      (chunk) => chunks.push(chunk),
    );

    expect(result.content).toBe("hello");
    expect(result.model).toBe("gpt-5-codex");
    expect(result.inputTokens).toBe(7);
    expect(result.outputTokens).toBe(2);
    expect(chunks).toEqual([
      { type: "text", content: "hel" },
      { type: "text", content: "lo" },
      { type: "done", content: "" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      stream: true,
      instructions: "be brief",
      max_output_tokens: 32,
    });
  });

  it("returns the output text and usage for a non-streaming prompt", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = setUp(calls);
    const session = await provider.createSession({
      name: "send",
      agentType: "codex",
    });

    const result = await provider.sendPrompt(session.id, "hi");

    expect(result.content).toBe("hello");
    expect(result.inputTokens).toBe(7);
    expect(result.outputTokens).toBe(2);
    expect(calls[0]).not.toHaveProperty("stream");
  });
});
