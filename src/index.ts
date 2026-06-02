/**
 * vibe-plugin-codex
 *
 * OpenAI Codex AI agent provider for VibeControls Agent.
 * Implements the AIAgentProvider interface with dual-mode support:
 * - SDK mode: Uses the openai SDK for direct API access
 * - CLI mode: Uses the `codex` CLI with `--quiet -a full-auto` flags
 *
 * Mode auto-detection: SDK if OPENAI_API_KEY is set, CLI if `codex`
 * binary is found, error if neither is available.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import type {
  HostServices,
  VibePlugin,
  ProfileContext,
} from "@vibecontrols/plugin-sdk";
import {
  BoundLogger,
  ProviderRegistry,
  TelemetryEmitter,
  createLifecycleHooks,
} from "@vibecontrols/plugin-sdk";

// ── AI Provider Contract Types ──────────────────────────────────────────
// (provider-specific contract — kept inline; not part of the SDK surface)

type ProviderMode = "sdk" | "cli";

interface AIModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsVision: boolean;
  supportsStreaming: boolean;
  inputPricePerMToken: number;
  outputPricePerMToken: number;
}

interface AIProviderCapabilities {
  streaming: boolean;
  vision: boolean;
  fileAttachments: boolean;
  toolUse: boolean;
  mcpSupport: boolean;
  voiceMode: boolean;
  cancelSupport: boolean;
  modelListing: boolean;
}

interface AIFileAttachment {
  filename: string;
  mimeType: string;
  content: Buffer | string;
  size: number;
}

type AISessionStatus =
  | "active"
  | "idle"
  | "processing"
  | "error"
  | "terminated";
type AILogType =
  | "input"
  | "output"
  | "thinking"
  | "event"
  | "error"
  | "metadata";

export type PermissionMode = "plan" | "acceptEdits" | "fullAuto";

interface AISessionConfig {
  name: string;
  agentType: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  workingDirectory?: string;
  /** Autonomy level for CLI mode; ignored by the SDK adapter. */
  permissionMode?: PermissionMode;
  providerConfig?: Record<string, unknown>;
}

interface AISession {
  id: string;
  name: string;
  status: AISessionStatus;
  agentType: string;
  provider: string;
  config: AISessionConfig;
  stats: AIUsageStats;
  createdAt: string;
  updatedAt: string;
}

interface AIContext {
  id: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface AIResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingSteps?: string[];
  durationMs: number;
  metadata?: Record<string, unknown>;
}

interface AIStreamChunk {
  type: "text" | "thinking" | "error" | "done";
  content: string;
  tokensUsed?: number;
}

interface AILog {
  id: string;
  sessionId: string;
  type: AILogType;
  content: string;
  tokenCount?: number;
  model?: string;
  durationMs?: number;
  agentMetadata?: Record<string, unknown>;
  createdAt: string;
}

interface AILogFilter {
  types?: AILogType[];
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

interface AIUsageStats {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  estimatedCostUsd: number;
  modelBreakdown?: Record<
    string,
    { inputTokens: number; outputTokens: number; requestCount: number }
  >;
}

interface AIAgentProvider {
  readonly name: string;
  createSession(config: AISessionConfig): Promise<AISession>;
  sendPrompt(
    sessionId: string,
    prompt: string,
    context?: AIContext[],
  ): Promise<AIResponse>;
  streamPrompt?(
    sessionId: string,
    prompt: string,
    context?: AIContext[],
    onChunk?: (chunk: AIStreamChunk) => void,
  ): Promise<AIResponse>;
  getSessionLogs(sessionId: string, filter?: AILogFilter): Promise<AILog[]>;
  getUsageStats(sessionId: string): Promise<AIUsageStats>;
  configureSession(
    sessionId: string,
    config: Partial<AISessionConfig>,
  ): Promise<void>;
  destroySession(sessionId: string): Promise<void>;
  listSessions(): Promise<AISession[]>;
  getSessionStatus(sessionId: string): Promise<AISessionStatus>;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
  listModels?(): Promise<AIModelInfo[]>;
  cancelRequest?(sessionId: string): Promise<void>;
  getCapabilities?(): AIProviderCapabilities;
  attachFiles?(sessionId: string, files: AIFileAttachment[]): Promise<void>;
  getMode?(): ProviderMode;
  setMode?(mode: ProviderMode): void;
  getCliLaunchSpec(): {
    binary: string;
    baseArgs?: string[];
    env?: Record<string, string>;
  } | null;
  sdkOneShot(opts: {
    prompt: string;
    model?: string;
    maxTokens?: number;
    extras?: Record<string, unknown>;
  }): Promise<{ text: string; usage?: unknown }>;
}

// Log ingester interface (from ai plugin's service registry)
interface LogIngester {
  append(input: {
    sessionId: string;
    type: AILogType;
    content: string;
    tokenCount?: number;
    model?: string;
    durationMs?: number;
    agentMetadata?: Record<string, unknown>;
  }): unknown;
}

// ── Provider Adapter Interface ──────────────────────────────────────────

interface ProviderAdapter {
  readonly mode: ProviderMode;

  sendPrompt(
    prompt: string,
    config: AISessionConfig,
    _signal?: AbortSignal,
  ): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    metadata?: Record<string, unknown>;
  }>;

  streamPrompt(
    prompt: string,
    config: AISessionConfig,
    onChunk: (chunk: AIStreamChunk) => void,
    _signal?: AbortSignal,
  ): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    metadata?: Record<string, unknown>;
  }>;

  healthCheck(): Promise<{ ok: boolean; message?: string }>;
}

// ── Constants ───────────────────────────────────────────────────────────

const PROVIDER_NAME = "codex";
const CLI_COMMAND = "codex";
/**
 * Resolve CLI binary path with platform-correct extension.
 * On Windows, Bun.spawn calls CreateProcess directly (no PATHEXT), so a bare
 * name won't find `name.exe`/`name.cmd`. Bun.which searches PATH like the shell.
 */
function platformExeName(base: string): string {
  return process.platform === "win32" ? `${base}.exe` : base;
}

function resolveCliBin(): string {
  const found =
    typeof Bun !== "undefined" && typeof Bun.which === "function"
      ? Bun.which(CLI_COMMAND, { PATH: process.env.PATH })
      : null;
  if (found) return found;
  return platformExeName(CLI_COMMAND);
}
const CLI_BIN = resolveCliBin();

const DISPLAY_NAME = "OpenAI Codex";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_MAX_TOKENS = 16_384;
const API_PREFIX = `/api/ai-${PROVIDER_NAME}`;
const SUPPORTED_MODES: ProviderMode[] = ["sdk", "cli"];
const CLI_NPM_PACKAGE = "@openai/codex";

const CODEX_MODELS: AIModelInfo[] = [
  {
    id: "codex-mini-latest",
    name: "Codex Mini",
    provider: PROVIDER_NAME,
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsVision: false,
    supportsStreaming: true,
    inputPricePerMToken: 1.5,
    outputPricePerMToken: 6.0,
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: PROVIDER_NAME,
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    supportsVision: true,
    supportsStreaming: true,
    inputPricePerMToken: 2.0,
    outputPricePerMToken: 8.0,
  },
  {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    provider: PROVIDER_NAME,
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    supportsVision: true,
    supportsStreaming: true,
    inputPricePerMToken: 0.4,
    outputPricePerMToken: 1.6,
  },
  {
    id: "gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    provider: PROVIDER_NAME,
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    supportsVision: true,
    supportsStreaming: true,
    inputPricePerMToken: 0.1,
    outputPricePerMToken: 0.4,
  },
  {
    id: "o4-mini",
    name: "o4-mini",
    provider: PROVIDER_NAME,
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsVision: true,
    supportsStreaming: true,
    inputPricePerMToken: 1.1,
    outputPricePerMToken: 4.4,
  },
];

// ── SDK Adapter ─────────────────────────────────────────────────────────

/** OpenAI SDK type aliases to avoid importing at module level */
interface OpenAIClient {
  responses: {
    create(
      params: Record<string, unknown>,
    ): Promise<OpenAIResponse> & AsyncIterable<OpenAIStreamEvent>;
  };
}

interface OpenAIResponse {
  id: string;
  output: Array<{
    type: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamEvent {
  type: string;
  delta?: string;
}

class CodexSdkAdapter implements ProviderAdapter {
  readonly mode: ProviderMode = "sdk";
  private client: OpenAIClient | null = null;
  private readonly resolveApiKey: () => Promise<string | undefined>;

  /**
   * Takes an async resolver so the key is read fresh from env OR the agent
   * config bag the frontend writes to (PUT /api/config/OPENAI_API_KEY) at
   * first use, rather than only from process.env at construction time.
   */
  constructor(resolveApiKey: () => Promise<string | undefined>) {
    this.resolveApiKey = resolveApiKey;
  }

  private async getClient(): Promise<OpenAIClient> {
    if (this.client) return this.client;

    const apiKey = (await this.resolveApiKey())?.trim();
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is required for SDK mode. Set it in the AI provider " +
          "credentials (stored in the agent config) or export it in the agent " +
          "environment.",
      );
    }

    let OpenAI: new (opts: { apiKey: string }) => unknown;
    try {
      const mod = await import("openai");
      OpenAI = (mod.default ?? mod) as new (opts: {
        apiKey: string;
      }) => unknown;
    } catch {
      throw new Error(
        "Failed to load openai SDK. Install it with: bun add openai",
      );
    }
    this.client = new OpenAI({ apiKey }) as unknown as OpenAIClient;
    return this.client;
  }

  async sendPrompt(
    prompt: string,
    config: AISessionConfig,
    _signal?: AbortSignal,
  ): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    metadata?: Record<string, unknown>;
  }> {
    const client = await this.getClient();
    const startTime = Date.now();
    const model = config.model || DEFAULT_MODEL;

    const params: Record<string, unknown> = {
      model,
      input: prompt,
    };

    if (config.systemPrompt) {
      params["instructions"] = config.systemPrompt;
    }

    if (config.maxTokens) {
      params["max_output_tokens"] = config.maxTokens;
    }

    const response = (await client.responses.create(params)) as OpenAIResponse;
    const durationMs = Date.now() - startTime;

    const content = this.extractResponseText(response);

    return {
      content,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      durationMs,
      metadata: { provider: PROVIDER_NAME, mode: "sdk" },
    };
  }

  async streamPrompt(
    prompt: string,
    config: AISessionConfig,
    onChunk: (chunk: AIStreamChunk) => void,
    _signal?: AbortSignal,
  ): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    metadata?: Record<string, unknown>;
  }> {
    const client = await this.getClient();
    const startTime = Date.now();
    const model = config.model || DEFAULT_MODEL;

    const params: Record<string, unknown> = {
      model,
      input: prompt,
      stream: true,
    };

    if (config.systemPrompt) {
      params["instructions"] = config.systemPrompt;
    }

    if (config.maxTokens) {
      params["max_output_tokens"] = config.maxTokens;
    }

    const stream = client.responses.create(
      params,
    ) as AsyncIterable<OpenAIStreamEvent>;

    const collectedText: string[] = [];
    let finalModel = model;
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const event of stream) {
      if (event.type === "response.output_text.delta" && event.delta) {
        collectedText.push(event.delta);
        onChunk({ type: "text", content: event.delta });
      } else if (event.type === "response.completed") {
        const completed = event as unknown as {
          response?: OpenAIResponse;
        };
        if (completed.response) {
          finalModel = completed.response.model;
          inputTokens = completed.response.usage.input_tokens;
          outputTokens = completed.response.usage.output_tokens;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const content = collectedText.join("");

    // Fallback token estimation if streaming did not provide usage
    if (inputTokens === 0 && outputTokens === 0) {
      inputTokens = Math.ceil(prompt.length / 4);
      outputTokens = Math.ceil(content.length / 4);
    }

    onChunk({ type: "done", content: "" });

    return {
      content,
      model: finalModel,
      inputTokens,
      outputTokens,
      durationMs,
      metadata: { provider: PROVIDER_NAME, mode: "sdk" },
    };
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.getClient();
      return {
        ok: true,
        message: `${DISPLAY_NAME} SDK ready (API key configured)`,
      };
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error ? err.message : "SDK initialization failed",
      };
    }
  }

  private extractResponseText(response: OpenAIResponse): string {
    const parts: string[] = [];
    for (const output of response.output) {
      if (output.type === "message" && output.content) {
        for (const block of output.content) {
          if (block.type === "output_text" && block.text) {
            parts.push(block.text);
          }
        }
      }
    }
    return parts.join("");
  }
}

// ── CLI Adapter ─────────────────────────────────────────────────────────

/**
 * Map the provider-agnostic permission mode to Codex CLI approval/sandbox
 * flags (`codex --help`: -a/--ask-for-approval {untrusted|on-request|never},
 * --sandbox {read-only|workspace-write}). We use the explicit `-a`/`--sandbox`
 * pair for every level (including fullAuto → `-a never --sandbox workspace-write`,
 * the documented expansion of the `--full-auto` convenience flag) so the mapping
 * is unambiguous and stable across CLI versions rather than depending on the
 * `--full-auto` shorthand existing. Unknown/undefined → acceptEdits (never the
 * most-permissive level). Flags are CLI-version-dependent.
 */
export function permissionFlags(mode: PermissionMode | undefined): string[] {
  switch (mode) {
    case "plan":
      // Read-only sandbox: the model can inspect but never mutate or escalate.
      return ["--sandbox", "read-only"];
    case "fullAuto":
      // Non-interactive auto-run. `--full-auto` maps to `-a on-request`, which
      // would BLOCK on an approval prompt under `exec` (no TTY) — so we use the
      // bypass flag, which is safe because the agent already runs inside the
      // vibecontrols sandbox container.
      return ["--dangerously-bypass-approvals-and-sandbox"];
    case "acceptEdits":
    default:
      // Writes confined to the workspace; no interactive approval under exec.
      return ["--sandbox", "workspace-write"];
  }
}

class CodexCliAdapter implements ProviderAdapter {
  readonly mode: ProviderMode = "cli";
  private readonly resolveApiKey: () => Promise<string | undefined>;
  private loggedInKey: string | null = null;

  constructor(resolveApiKey: () => Promise<string | undefined>) {
    this.resolveApiKey = resolveApiKey;
  }

  /**
   * Codex CLI auth dir. We keep it OFF the operator's default `~/.codex` so
   * an API key the user saved in the agent never clobbers (or is shadowed by)
   * a personal `codex login`. An explicit CODEX_HOME still wins for operators
   * who deliberately set one.
   */
  private codexHome(): string {
    const home =
      process.env["CODEX_HOME"]?.trim() || join(tmpdir(), "vibe-codex-home");
    try {
      mkdirSync(home, { recursive: true });
    } catch {
      /* best effort — exec will surface a real error if the dir is unusable */
    }
    return home;
  }

  /**
   * Modern Codex authenticates from `auth.json` (written by `codex login`),
   * NOT from the OPENAI_API_KEY env var, so injecting the env alone leaves it
   * unauthenticated. When the user has saved a key we write it into our scoped
   * CODEX_HOME via `codex login --with-api-key` (reads the key from stdin),
   * once per distinct key. With no key we leave whatever auth already exists.
   */
  private async ensureAuth(home: string): Promise<void> {
    const apiKey = (await this.resolveApiKey())?.trim();
    if (!apiKey || apiKey === this.loggedInKey) return;
    const proc = Bun.spawn([CLI_BIN, "login", "--with-api-key"], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      env: { ...(process.env as Record<string, string>), CODEX_HOME: home },
      timeout: 30_000,
    });
    proc.stdin.write(apiKey);
    await proc.stdin.end();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      this.loggedInKey = apiKey;
    } else {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `Codex CLI login failed (exit ${exitCode}): ${stderr.trim()}`,
      );
    }
  }

  /**
   * Build args for the modern Codex CLI (`codex exec ...`). Earlier versions
   * accepted `codex --quiet <prompt>`; current releases (0.40+) reject bare
   * `--quiet` and require the `exec` subcommand for non-interactive runs.
   * `--skip-git-repo-check` lets it run in any working directory and
   * `--color never` keeps the captured stdout free of ANSI control codes.
   */
  private buildCliArgs(config: AISessionConfig, prompt: string): string[] {
    const args: string[] = [
      "exec",
      "--skip-git-repo-check",
      "--color",
      "never",
      ...permissionFlags(config.permissionMode),
    ];
    if (config.model) args.push("--model", config.model);
    args.push(prompt);
    return args;
  }

  /** Spawn env with the resolved OPENAI_API_KEY + scoped CODEX_HOME. */
  private async spawnEnv(home: string): Promise<Record<string, string>> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CODEX_HOME: home,
    };
    const apiKey = (await this.resolveApiKey())?.trim();
    if (apiKey) env["OPENAI_API_KEY"] = apiKey;
    return env;
  }

  async sendPrompt(
    prompt: string,
    config: AISessionConfig,
  ): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    metadata?: Record<string, unknown>;
  }> {
    const startTime = Date.now();
    const args = this.buildCliArgs(config, prompt);
    const home = this.codexHome();
    await this.ensureAuth(home);

    const proc = Bun.spawn([CLI_BIN, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: config.workingDirectory || process.cwd(),
      env: await this.spawnEnv(home),
      timeout: (config.providerConfig?.["timeoutMs"] as number) || 300_000,
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const durationMs = Date.now() - startTime;

    if (exitCode !== 0 && !stdout) {
      throw new Error(
        `${DISPLAY_NAME} CLI exited with code ${exitCode}: ${stderr}`,
      );
    }

    const content = stdout.trim() || stderr.trim();
    // CLI does not provide real token counts; approximate from character lengths
    const inputTokens = Math.ceil(prompt.length / 4);
    const outputTokens = Math.ceil(content.length / 4);
    const model = config.model || DEFAULT_MODEL;

    return {
      content,
      model,
      inputTokens,
      outputTokens,
      durationMs,
      metadata: { exitCode, provider: PROVIDER_NAME, mode: "cli" },
    };
  }

  async streamPrompt(
    prompt: string,
    config: AISessionConfig,
    onChunk: (chunk: AIStreamChunk) => void,
  ): Promise<{
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    metadata?: Record<string, unknown>;
  }> {
    // CLI does not support true streaming; run full prompt then emit chunks
    const result = await this.sendPrompt(prompt, config);
    onChunk({ type: "text", content: result.content });
    onChunk({ type: "done", content: "" });
    return result;
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const proc = Bun.spawnSync([CLI_BIN, "--version"], {
        timeout: 5000,
        stdout: "pipe",
        stderr: "ignore",
      });
      if (proc.exitCode === 0) {
        return {
          ok: true,
          message: `${DISPLAY_NAME} CLI ${proc.stdout.toString().trim()}`,
        };
      }
      return {
        ok: false,
        message: `${DISPLAY_NAME} CLI not available (exit code ${proc.exitCode})`,
      };
    } catch {
      return {
        ok: false,
        message: `${DISPLAY_NAME} CLI not installed or not in PATH`,
      };
    }
  }
}

// ── Provider Implementation ─────────────────────────────────────────────

interface ManagedSession {
  id: string;
  config: AISessionConfig;
  status: AISessionStatus;
  stats: AIUsageStats;
  abortController: AbortController | null;
  files: AIFileAttachment[];
  createdAt: string;
  updatedAt: string;
}

class CodexProvider implements AIAgentProvider {
  readonly name = PROVIDER_NAME;
  private sessions = new Map<string, ManagedSession>();
  private logIngester: LogIngester | null = null;
  private hostServices: HostServices | null = null;
  private logger: BoundLogger | null = null;
  private activeMode: ProviderMode | null = null;
  private adapter: ProviderAdapter | null = null;
  private cachedApiKey: string | undefined;

  setHostServices(hs: HostServices): void {
    this.hostServices = hs;
    this.logger = new BoundLogger(hs.logger, `${PROVIDER_NAME}-provider`);
    const registry = new ProviderRegistry(hs);
    this.logIngester =
      registry.getProvider<LogIngester>("ai", "log-ingester") ?? null;

    // Warm the cache so detectMode()/getCliLaunchSpec() (sync) see a key the
    // user stored in the agent config bag, not just env vars.
    void Promise.resolve(hs.getConfig?.("OPENAI_API_KEY"))
      .then((apiKey) => {
        const trimmed = apiKey?.trim();
        if (trimmed) this.cachedApiKey = trimmed;
      })
      .catch(() => {});
  }

  /**
   * Resolve OPENAI_API_KEY from env (operator override wins), the warmed
   * cache, then the agent config bag the frontend writes to. Mirrors the
   * resolution the other providers use so SDK + CLI mode work with a key
   * saved purely through the UI.
   */
  private async resolveApiKey(): Promise<string | undefined> {
    const envKey = process.env["OPENAI_API_KEY"]?.trim();
    if (envKey) return envKey;

    if (this.cachedApiKey) return this.cachedApiKey;

    if (this.hostServices?.getConfig) {
      try {
        const apiKey = (
          await this.hostServices.getConfig("OPENAI_API_KEY")
        )?.trim();
        if (apiKey) {
          this.cachedApiKey = apiKey;
          return apiKey;
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  getSupportedModes(): ProviderMode[] {
    return [...SUPPORTED_MODES];
  }

  getDisplayName(): string {
    return DISPLAY_NAME;
  }

  getPrereqApiPrefix(): string {
    return API_PREFIX;
  }

  // ── Mode Management ──────────────────────────────────────────────────

  getMode(): ProviderMode {
    if (this.activeMode) return this.activeMode;
    return this.detectMode();
  }

  setMode(mode: ProviderMode): void {
    if (!SUPPORTED_MODES.includes(mode)) {
      throw new Error(`${DISPLAY_NAME} does not support ${mode} mode`);
    }
    this.activeMode = mode;
    this.adapter = null; // Force re-creation on next use
    this.log("info", `Mode explicitly set to: ${mode}`);
  }

  private detectMode(): ProviderMode {
    if (process.env["OPENAI_API_KEY"]?.trim() || this.cachedApiKey)
      return "sdk";

    try {
      // Cross-platform binary discovery via Bun.which (handles PATHEXT on Windows).
      if (Bun.which(CLI_COMMAND, { PATH: process.env.PATH })) return "cli";
    } catch {
      // CLI not found
    }

    // Default to SDK mode; healthCheck will report the actual failure
    return "sdk";
  }

  private getAdapter(): ProviderAdapter {
    if (this.adapter) return this.adapter;

    const mode = this.getMode();
    this.adapter =
      mode === "sdk"
        ? new CodexSdkAdapter(() => this.resolveApiKey())
        : new CodexCliAdapter(() => this.resolveApiKey());
    this.activeMode = mode;
    this.log("info", `Adapter initialized in ${mode} mode`);
    return this.adapter;
  }

  // ── Session Management ───────────────────────────────────────────────

  async createSession(config: AISessionConfig): Promise<AISession> {
    const id =
      (config.providerConfig?.["sessionId"] as string) || crypto.randomUUID();
    const now = new Date().toISOString();

    // If session already exists in memory, return it
    const existing = this.sessions.get(id);
    if (existing) {
      existing.status = "active";
      existing.updatedAt = now;
      return this.toAISession(existing);
    }

    const session: ManagedSession = {
      id,
      config,
      status: "active",
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 0,
        estimatedCostUsd: 0,
      },
      abortController: null,
      files: [],
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(id, session);
    this.log("info", `Session created: ${id} (${config.name})`);

    return this.toAISession(session);
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
    context?: AIContext[],
  ): Promise<AIResponse> {
    const session = this.getSession(sessionId);
    session.status = "processing";
    session.updatedAt = new Date().toISOString();

    const abortController = new AbortController();
    session.abortController = abortController;

    const fullPrompt = this.buildFullPrompt(prompt, context, session.files);

    this.logIngester?.append({
      sessionId,
      type: "input",
      content: prompt,
    });

    try {
      const adapter = this.getAdapter();
      const result = await adapter.sendPrompt(
        fullPrompt,
        session.config,
        abortController.signal,
      );

      this.updateSessionStats(session, result.inputTokens, result.outputTokens);

      this.logIngester?.append({
        sessionId,
        type: "output",
        content: result.content,
        tokenCount: result.outputTokens,
        model: result.model,
        durationMs: result.durationMs,
      });

      return {
        content: result.content,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        metadata: result.metadata,
      };
    } catch (err) {
      session.status = "error";
      session.updatedAt = new Date().toISOString();

      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      this.logIngester?.append({
        sessionId,
        type: "error",
        content: errorMsg,
      });

      throw err;
    } finally {
      session.abortController = null;
    }
  }

  async streamPrompt(
    sessionId: string,
    prompt: string,
    context?: AIContext[],
    onChunk?: (chunk: AIStreamChunk) => void,
  ): Promise<AIResponse> {
    const session = this.getSession(sessionId);
    session.status = "processing";
    session.updatedAt = new Date().toISOString();

    const abortController = new AbortController();
    session.abortController = abortController;

    const fullPrompt = this.buildFullPrompt(prompt, context, session.files);

    this.logIngester?.append({
      sessionId,
      type: "input",
      content: prompt,
    });

    try {
      const adapter = this.getAdapter();
      const chunkHandler = onChunk ?? ((_c: AIStreamChunk) => {});

      const result = await adapter.streamPrompt(
        fullPrompt,
        session.config,
        chunkHandler,
        abortController.signal,
      );

      this.updateSessionStats(session, result.inputTokens, result.outputTokens);

      this.logIngester?.append({
        sessionId,
        type: "output",
        content: result.content,
        tokenCount: result.outputTokens,
        model: result.model,
        durationMs: result.durationMs,
      });

      return {
        content: result.content,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        metadata: result.metadata,
      };
    } catch (err) {
      session.status = "error";
      session.updatedAt = new Date().toISOString();

      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      this.logIngester?.append({
        sessionId,
        type: "error",
        content: errorMsg,
      });

      throw err;
    } finally {
      session.abortController = null;
    }
  }

  // ── Extended Methods ─────────────────────────────────────────────────

  async listModels(): Promise<AIModelInfo[]> {
    return [...CODEX_MODELS];
  }

  async cancelRequest(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    if (session.abortController) {
      session.abortController.abort();
      session.abortController = null;
      session.status = "active";
      session.updatedAt = new Date().toISOString();
      this.log("info", `Request cancelled for session: ${sessionId}`);
    }
  }

  getCapabilities(): AIProviderCapabilities {
    const mode = this.getMode();
    return {
      streaming: mode === "sdk",
      vision: mode === "sdk",
      fileAttachments: true,
      toolUse: false,
      mcpSupport: false,
      voiceMode: false,
      cancelSupport: mode === "sdk",
      modelListing: true,
    };
  }

  async attachFiles(
    sessionId: string,
    files: AIFileAttachment[],
  ): Promise<void> {
    const session = this.getSession(sessionId);
    session.files.push(...files);
    session.updatedAt = new Date().toISOString();
    this.log(
      "debug",
      `Attached ${files.length} file(s) to session ${sessionId}`,
    );
  }

  // ── Standard Methods ─────────────────────────────────────────────────

  async getSessionLogs(
    _sessionId: string,
    _filter?: AILogFilter,
  ): Promise<AILog[]> {
    return [];
  }

  async getUsageStats(sessionId: string): Promise<AIUsageStats> {
    const session = this.sessions.get(sessionId);
    return (
      session?.stats ?? {
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 0,
        estimatedCostUsd: 0,
      }
    );
  }

  async configureSession(
    sessionId: string,
    config: Partial<AISessionConfig>,
  ): Promise<void> {
    const session = this.getSession(sessionId);
    Object.assign(session.config, config);
    session.updatedAt = new Date().toISOString();
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.abortController) {
        session.abortController.abort();
        session.abortController = null;
      }
      session.status = "terminated";
      session.files = [];
      session.updatedAt = new Date().toISOString();
      this.log("info", `Session terminated: ${sessionId}`);
    }
  }

  async listSessions(): Promise<AISession[]> {
    return Array.from(this.sessions.values()).map((s) => this.toAISession(s));
  }

  async getSessionStatus(sessionId: string): Promise<AISessionStatus> {
    return this.sessions.get(sessionId)?.status ?? "terminated";
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    const adapter = this.getAdapter();
    return adapter.healthCheck();
  }

  // ── `vibe ai run` / `vibe ai sdk` integration ────────────────────────

  getCliLaunchSpec(): {
    binary: string;
    baseArgs?: string[];
    env?: Record<string, string>;
  } | null {
    const env: Record<string, string> = {};
    const apiKey = process.env["OPENAI_API_KEY"]?.trim() || this.cachedApiKey;
    if (apiKey) env["OPENAI_API_KEY"] = apiKey;
    return { binary: CLI_COMMAND, env };
  }

  async sdkOneShot(opts: {
    prompt: string;
    model?: string;
    maxTokens?: number;
    extras?: Record<string, unknown>;
  }): Promise<{ text: string; usage?: unknown }> {
    const adapter = new CodexSdkAdapter(() => this.resolveApiKey());
    const config: AISessionConfig = {
      name: "vibe-ai-sdk",
      agentType: PROVIDER_NAME,
      model: opts.model ?? DEFAULT_MODEL,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      providerConfig: opts.extras,
    };
    const result = await adapter.sendPrompt(opts.prompt, config);
    return {
      text: result.content,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: result.model,
        durationMs: result.durationMs,
      },
    };
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private getSession(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status === "terminated")
      throw new Error("Session is terminated");
    return session;
  }

  private buildFullPrompt(
    prompt: string,
    context?: AIContext[],
    files?: AIFileAttachment[],
  ): string {
    let fullPrompt = prompt;

    if (context && context.length > 0) {
      const contextStr = context
        .map((c) => `--- Context (${c.type}): ---\n${c.content}`)
        .join("\n\n");
      fullPrompt = `${prompt}\n\n${contextStr}`;
    }

    if (files && files.length > 0) {
      const fileStr = files
        .map((f) => {
          const textContent =
            typeof f.content === "string"
              ? f.content
              : f.content.toString("utf-8");
          return `--- File: ${f.filename} (${f.mimeType}, ${f.size} bytes) ---\n${textContent}`;
        })
        .join("\n\n");
      fullPrompt = `${fullPrompt}\n\n${fileStr}`;
    }

    return fullPrompt;
  }

  private updateSessionStats(
    session: ManagedSession,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const model = session.config.model || DEFAULT_MODEL;
    const modelInfo = CODEX_MODELS.find((m) => m.id === model);

    session.stats.inputTokens += inputTokens;
    session.stats.outputTokens += outputTokens;
    session.stats.requestCount += 1;

    if (modelInfo) {
      const cost =
        (inputTokens / 1_000_000) * modelInfo.inputPricePerMToken +
        (outputTokens / 1_000_000) * modelInfo.outputPricePerMToken;
      session.stats.estimatedCostUsd += cost;
    }

    if (!session.stats.modelBreakdown) {
      session.stats.modelBreakdown = {};
    }
    const breakdown = session.stats.modelBreakdown[model] ?? {
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
    };
    breakdown.inputTokens += inputTokens;
    breakdown.outputTokens += outputTokens;
    breakdown.requestCount += 1;
    session.stats.modelBreakdown[model] = breakdown;

    session.status = "active";
    session.updatedAt = new Date().toISOString();
  }

  private toAISession(s: ManagedSession): AISession {
    return {
      id: s.id,
      name: s.config.name,
      status: s.status,
      agentType: s.config.agentType,
      provider: PROVIDER_NAME,
      config: s.config,
      stats: s.stats,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  private log(level: "info" | "error" | "debug", msg: string): void {
    this.logger?.[level](msg);
  }
}

// ── Plugin Export ────────────────────────────────────────────────────────

function getCliVersion(): string | null {
  try {
    const proc = Bun.spawnSync([CLI_BIN, "--version"], {
      timeout: 5000,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch {
    // Binary not found.
  }
  return null;
}

/**
 * Install a global npm CLI, runtime-resiliently. The agent always ships Bun
 * (it IS a Bun process) but NOT npm/node — the production agent image is Alpine
 * + Bun only — so a hard-coded `npm install -g` silently fails there. We try
 * each available global installer in turn and report the last error.
 */
function installGlobalNpmCli(pkgSpec: string): {
  ok: boolean;
  message: string;
} {
  const candidates: string[][] = [
    ["bun", "install", "-g", pkgSpec],
    ["npm", "install", "-g", pkgSpec],
  ];
  let lastError = "";
  for (const cmd of candidates) {
    const exe = cmd[0]!;
    if (!Bun.which(exe, { PATH: process.env.PATH })) continue;
    try {
      const proc = Bun.spawnSync(cmd, {
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode === 0) return { ok: true, message: cmd.join(" ") };
      lastError =
        proc.stderr.toString().trim() || `${exe} exited ${proc.exitCode}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    ok: false,
    message:
      lastError ||
      `No global installer (bun/npm) found. Run manually: bun install -g ${pkgSpec}`,
  };
}

function createPrereqsRoutes() {
  return new Elysia({ prefix: "/prereqs" })
    .get("/status", () => {
      const version = getCliVersion();
      return {
        satisfied: Boolean(version),
        missing: version
          ? []
          : [
              {
                name: CLI_COMMAND,
                kind: "npm" as const,
                requiresSudo: false,
                description: `${DISPLAY_NAME} CLI for CLI mode`,
              },
            ],
      };
    })
    .post("/install", () => {
      if (getCliVersion()) {
        return {
          ok: true,
          installed: [CLI_COMMAND],
          pendingSudo: [],
          errors: [],
        };
      }

      const result = installGlobalNpmCli(CLI_NPM_PACKAGE);
      if (result.ok) {
        return {
          ok: true,
          installed: [CLI_COMMAND],
          pendingSudo: [],
          errors: [],
        };
      }
      return {
        ok: false,
        installed: [],
        pendingSudo: [],
        errors: [{ name: CLI_COMMAND, message: result.message }],
      };
    });
}

const PLUGIN_NAME = "codex";
const PLUGIN_VERSION = "1.0.0";

const provider = new CodexProvider();

const lifecycle = createLifecycleHooks({
  name: PLUGIN_NAME,
  telemetryEventName: "ai.provider.ready",
  onInit: (hostServices: HostServices) => {
    provider.setHostServices(hostServices);
    new TelemetryEmitter(PLUGIN_NAME, PLUGIN_VERSION, hostServices).emit(
      "ai.provider.ready",
      { provider: PLUGIN_NAME },
    );
  },
  onShutdown: () => {
    for (const [id] of (provider as CodexProvider)["sessions"]) {
      provider.destroySession(id).catch(() => {});
    }
  },
});

type CodexVibePlugin = VibePlugin & {
  providers?: { ai?: AIAgentProvider };
};

export const createPlugin = (_ctx: ProfileContext): CodexVibePlugin => ({
  capabilities: {
    secrets: "read",
    subprocess: true,
    gateway: false,
    telemetry: true,
  },
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  description:
    "OpenAI Codex AI agent provider for VibeControls (dual-mode: SDK + CLI)",
  tags: ["provider", "integration"],
  apiPrefix: API_PREFIX,
  prerequisites: [
    {
      name: CLI_COMMAND,
      kind: "npm",
      requiresSudo: false,
    },
  ],
  providers: { ai: provider },
  createRoutes: () => createPrereqsRoutes(),
  onServerStart: lifecycle.onServerStart,
  onServerStop: lifecycle.onServerStop,
});
