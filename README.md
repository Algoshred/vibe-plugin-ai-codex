# @vibecontrols/vibe-plugin-ai-codex

<!-- VIBECONTROLS_OSS_BODY_START -->

> OpenAI Codex CLI — agentic coding from OpenAI.

## Install

```bash
vibe plugin install @vibecontrols/vibe-plugin-ai-codex
```

Or install the npm package directly into an existing project that hosts the VibeControls agent:

```bash
bun add @vibecontrols/vibe-plugin-ai-codex
# or
npm install @vibecontrols/vibe-plugin-ai-codex
```

## How it works

AI **providers** implement the `AIProvider` contract from `@vibecontrols/vibe-plugin-ai` (meta). Once installed and registered, the agent can route prompts, hooks and MCP requests through this provider alongside any others you have configured. The meta plugin handles fan-out, provider selection and capability negotiation.

This package is a **provider** registered against the `@vibecontrols/vibe-plugin-ai` meta plugin. Install the meta plugin first; this provider plugs into it.

## Upstream

- **OpenAI Codex CLI** — <https://github.com/openai/codex>

## More

- npm: <https://www.npmjs.com/package/@vibecontrols/vibe-plugin-ai-codex>
- Source: <https://github.com/algoshred/vibe-plugin-ai-codex>
- Plugin contract / SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- Plugin catalogue: <https://vibecontrols.com/plugins/ai-codex>

<!-- VIBECONTROLS_OSS_BODY_END -->

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## Credits

This plugin builds on the following upstream open-source projects. All trademarks and copyrights remain with their respective owners.

- **OpenAI Codex CLI** — <https://github.com/openai/codex>

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

**Note**: this plugin is open source under MIT. The `@vibecontrols/agent` runtime that loads and orchestrates plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
