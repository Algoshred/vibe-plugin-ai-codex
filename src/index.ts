/**
 * vibe-plugin-codex
 *
 * OpenAI Codex AI agent provider for VibeControls Agent.
 * Implements the AIAgentProvider interface to manage Codex sessions.
 * Uses the `codex` CLI with `--quiet` and `-a full-auto` flags.
 */

// ── Locally Redeclared Interfaces ────────────────────────────────────────
// (Avoid hard dependency on @vibecontrols/agent)

interface VibePlugin {
  name: string;
  version: string;
  description?: string;
  tags?: Array<
    "backend" | "frontend" | "cli" | "provider" | "adapter" | "integration"
  >;
  cliCommand?: string;
  apiPrefix?: string;
  providers?: { ai?: AIAgentProvider; [key: string]: unknown };
  onServerStart?: (
    app: unknown,
    hostServices?: HostServices,
  ) => void | Promise<void>;
  onServerStop?: () => void | Promise<void>;
  onCliSetup?: (
    program: unknown,
    hostServices?: HostServices,
  ) => void | Promise<void>;
}

interface HostServices {
  logger?: {
    info: (source: string, msg: string) => void;
    warn: (source: string, msg: string) => void;
    error: (source: string, msg: string) => void;
    debug: (source: string, msg: string) => void;
  };
  serviceRegistry?: {
    getService: <T>(pluginName: string, serviceName: string) => T | undefined;
  };
  getConfig: (key: string) => string | undefined;
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

interface AISessionConfig {
  name: string;
  agentType: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  workingDirectory?: string;
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
}

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

// ── Provider Implementation ──────────────────────────────────────────────

const PROVIDER_NAME = "codex";
const CLI_COMMAND = "codex";
const DISPLAY_NAME = "OpenAI Codex";

interface ManagedSession {
  id: string;
  config: AISessionConfig;
  status: AISessionStatus;
  stats: AIUsageStats;
  createdAt: string;
  updatedAt: string;
}

class CodexProvider implements AIAgentProvider {
  readonly name = PROVIDER_NAME;
  private sessions = new Map<string, ManagedSession>();
  private logIngester: LogIngester | null = null;
  private hostServices: HostServices | null = null;

  setHostServices(hs: HostServices) {
    this.hostServices = hs;
    this.logIngester =
      hs.serviceRegistry?.getService<LogIngester>("ai", "log-ingester") ?? null;
  }

  async createSession(config: AISessionConfig): Promise<AISession> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

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
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(id, session);
    this.log("info", `Session created: ${id} (${config.name})`);

    return {
      id,
      name: config.name,
      status: "active",
      agentType: config.agentType,
      provider: PROVIDER_NAME,
      config,
      stats: session.stats,
      createdAt: now,
      updatedAt: now,
    };
  }

  async sendPrompt(
    sessionId: string,
    prompt: string,
    context?: AIContext[],
  ): Promise<AIResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status === "terminated")
      throw new Error("Session is terminated");

    session.status = "processing";
    session.updatedAt = new Date().toISOString();
    const startTime = Date.now();

    let fullPrompt = prompt;
    if (context && context.length > 0) {
      const contextStr = context
        .map((c) => `--- Context (${c.type}): ---\n${c.content}`)
        .join("\n\n");
      fullPrompt = `${prompt}\n\n${contextStr}`;
    }

    this.logIngester?.append({
      sessionId,
      type: "input",
      content: prompt,
    });

    try {
      const args = this.buildCliArgs(session.config, fullPrompt);
      const proc = Bun.spawn([CLI_COMMAND, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        cwd: session.config.workingDirectory || process.cwd(),
        timeout:
          (session.config.providerConfig?.timeoutMs as number) || 300_000,
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      const durationMs = Date.now() - startTime;

      if (exitCode !== 0 && !stdout) {
        throw new Error(
          `${DISPLAY_NAME} exited with code ${exitCode}: ${stderr}`,
        );
      }

      const content = stdout.trim() || stderr.trim();
      const inputTokens = Math.ceil(fullPrompt.length / 4);
      const outputTokens = Math.ceil(content.length / 4);
      const model = (session.config.model as string) || "default";

      session.stats.inputTokens += inputTokens;
      session.stats.outputTokens += outputTokens;
      session.stats.requestCount += 1;
      session.status = "active";
      session.updatedAt = new Date().toISOString();

      this.logIngester?.append({
        sessionId,
        type: "output",
        content,
        tokenCount: outputTokens,
        model,
        durationMs,
      });

      return {
        content,
        model,
        inputTokens,
        outputTokens,
        durationMs,
        metadata: { exitCode, provider: PROVIDER_NAME },
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
    }
  }

  private buildCliArgs(config: AISessionConfig, prompt: string): string[] {
    const args: string[] = ["--quiet", "-a", "full-auto"];
    if (config.model) args.push("--model", config.model);
    args.push(prompt);
    return args;
  }

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
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    Object.assign(session.config, config);
    session.updatedAt = new Date().toISOString();
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "terminated";
      session.updatedAt = new Date().toISOString();
      this.log("info", `Session terminated: ${sessionId}`);
    }
  }

  async listSessions(): Promise<AISession[]> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.config.name,
      status: s.status,
      agentType: s.config.agentType,
      provider: PROVIDER_NAME,
      config: s.config,
      stats: s.stats,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  async getSessionStatus(sessionId: string): Promise<AISessionStatus> {
    return this.sessions.get(sessionId)?.status ?? "terminated";
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const proc = Bun.spawnSync([CLI_COMMAND, "--version"], {
        timeout: 5000,
        stdout: "pipe",
        stderr: "ignore",
      });
      if (proc.exitCode === 0) {
        return {
          ok: true,
          message: `${DISPLAY_NAME} ${proc.stdout.toString().trim()}`,
        };
      }
      return {
        ok: false,
        message: `${DISPLAY_NAME} not available (exit code ${proc.exitCode})`,
      };
    } catch {
      return {
        ok: false,
        message: `${DISPLAY_NAME} not installed or not in PATH`,
      };
    }
  }

  private log(level: "info" | "error" | "debug", msg: string) {
    this.hostServices?.logger?.[level]?.(`${PROVIDER_NAME}-provider`, msg);
  }
}

// ── Plugin Export ────────────────────────────────────────────────────────

const provider = new CodexProvider();

export const vibePlugin: VibePlugin = {
  name: "codex",
  version: "1.0.0",
  description: "OpenAI Codex AI agent provider for VibeControls",
  tags: ["provider", "integration"],
  providers: { ai: provider },

  onServerStart(_app, hostServices) {
    if (hostServices) provider.setHostServices(hostServices);
  },

  onServerStop() {
    for (const [id] of (provider as CodexProvider)["sessions"]) {
      provider.destroySession(id).catch(() => {});
    }
  },
};

export default vibePlugin;
