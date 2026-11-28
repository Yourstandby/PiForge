<div align="center">

<img src="./public/logo.svg" width="96" alt="PiForge" />

# PiForge

**A quiet three-column workbench for the Pi coding agent**
*Local-first desktop workbench for the Pi coding agent — multi-session, multi-agent, cache-aware.*

**English** · [简体中文](./README.zh-CN.md)

[![Release](https://img.shields.io/github/v/release/Yourstandby/PiForge?sort=semver)](https://github.com/Yourstandby/PiForge/releases)
[![CI](https://github.com/Yourstandby/PiForge/actions/workflows/ci.yml/badge.svg)](https://github.com/Yourstandby/PiForge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Pi Core](https://img.shields.io/badge/pi--coding--agent-1.6.0-111)](https://github.com/earendil-works/pi)

v0.12.2 · Windows / macOS / Linux · Pi Coding Agent bundled, nothing else to install

</div>

---

## What is this

Agents work fine in a terminal — until you have three projects open, want to see exactly how many tokens are burning, want to stop a write mid-flight, or want the agent to spin up two read-only researchers on its own. That is where a terminal starts to pinch.

PiForge moves the whole loop into a native window:

- **Left column**: projects grouped by working directory, plus their session history
- **Center**: multi-tab conversations, live streaming, queued follow-ups
- **Right column**: file tree and viewer, built-in browser, terminal, Git, agent fleet, orchestrator, plugins

The main agent writes code; sub-agents only read and research, each with an isolated context. Inference, file access and session logs all stay on your machine.

---

## Features

### Sessions and workbench

| Feature | What it does |
|---|---|
| **Multi-tab chat** | Run several sessions against one project in parallel — switch, close and restore tabs |
| **Projects you control** | Projects are grouped by CWD automatically; rename or hide them from the sidebar. Only local preferences change — no session is deleted, no directory is touched |
| **Two kinds of branching** | Physical fork (a separate session file) and in-session rewind, with a branch navigator to compare different attempts |
| **Session export** | Export any session to HTML or Markdown for archiving and sharing |
| **Right-hand workspace** | File tree / viewer, built-in browser with per-domain permissions, terminal, Git panel (worktrees, branch clones), fleet, orchestrator, plugins, MCP resources |
| **Native shell** | Lives in the system tray, asks before closing (minimize to tray or quit, choice remembered), checks for updates |
| **Appearance and language** | Light / dark / Glacier themes, Chinese / English UI (follow-system supported) |

### Context and cost

- **Cache-friendly plan mode**: the tool declaration is decided by the preset alone, and the plan section is injected as a trailing `display:false` message — flipping between plan and execute keeps the request prefix byte-identical, so history is never resent wholesale (v0.12.1).
- **Context visibility and compaction**: a ring gauge for occupancy plus a four-part summary; the compaction summary is always Chinese and by default only takes over the body.
- **Token ledger**: sums only real `usage`, isolated per session; during streaming, no number is shown until there is one. Values are exact below 1000 and abbreviated to one decimal at or above (`2.9K` / `69.8K`).
- **No-progress watchdog**: lights up only after 90 seconds without meaningful progress (presets 90 / 120 / 300 / 600 s), so long jobs are no longer killed by mistake.
- **Measurable budgets**: `npm run measure:prefix` / `measure:long-session` / `measure:increment` report prefix hit rate and per-turn increment; numbers are archived in `docs/measurements/`.

### Modes and safety boundaries

- **plan / ask / full**: plan can only read — writes are rejected during execution (reason `Plan mode: planning only`); ask confirms sensitive tools first; full runs unrestricted. The mode persists with the session.
- **Tool presets**: `none` / `default` / `full`, deciding which tools the model can even see.
- **File authorization chain**: scope is validated against authorized roots plus a path policy, and "file does not exist" is reported separately from "outside the sandbox".
- **codemode defaults to `only`**: scripts run inside a sandboxed worker; full capability is not granted by default.
- **Native bridge for extension UI**: extension confirm / select / input / editor / notify render as native dialogs instead of falling back to the terminal.

### Multi-agent

- **Sub-agents**: `spawn_agent` creates read-only researchers with their own context; results are tagged with whether test/build evidence exists, so unverified output is never presented as verified.
- **Persistent fleet**: `herdr_*` tools manage long-lived agents, each with its own session and state.
- **Orchestration**: parallel workers run in isolated Git worktrees and report back with their changed files.
- **Observability**: badges for running tools, tool-call statistics, and stream health hints (reconnect and handshake failures are reported separately).

### Extension ecosystem

- **MCP**: two config levels — global `~/.pi/agent/mcp.json` and per-project `<cwd>/.pi/mcp.json` — with visual add/remove and resource browsing.
- **Skills / Extensions / Plugins**: one UI for enabling, diagnostics and installation.
- **Models and providers**: switch models at any time, auxiliary models for small chores, automatic routing, custom OpenAI-compatible providers.
- **Swappable Pi core**: the three `@earendil-works/pi-*` packages are pinned to exactly 1.6.0, and versions can be inspected and switched from the UI.

---

## Latest release v0.12.2

Theme: **running no longer looks stuck, queued messages are editable, plans no longer rot.**

- Conversations are no longer blanked out while tools run; when there truly is no history you get a "reload" button, with automatic retries backing off from 1.5s to 6s.
- Queued messages can be **edited** (attachments and position preserved), **⚡ sent immediately**, or **⏫ moved to the front of the queue**.
- A plan that stops halfway no longer disappears: unfinished plans keep their card with "continue" and "drop the rest" exits; completed steps lose their strikethrough and fold into a single line.
- The `mcp_servers` section is latched byte-for-byte by signature, so connecting to an MCP server no longer breaks the prefix cache.
- The fleet and orchestrator panels gain a manual `AgentSpawnTrigger` entry, so you need not wait for the main agent to call a tool.

Full changes: [CHANGELOG.md](./CHANGELOG.md) · [docs/releases/v0.12.2.md](./docs/releases/v0.12.2.md)

---

## Install

Download the installer for your platform from [Releases](https://github.com/Yourstandby/PiForge/releases):

| Platform | Artifact | First run |
|---|---|---|
| Windows | `PiForge-Setup-x.y.z.exe` / `PiForge.zip` | If SmartScreen blocks it, choose "More info → Run anyway" |
| macOS | `.dmg` (Universal, Intel + Apple Silicon) | Right-click → Open, or `xattr -dr com.apple.quarantine /Applications/PiForge.app` |
| Linux | `.AppImage` / `.deb` | Run the AppImage directly; the deb is unsigned, so use `sudo dpkg -i` |

> The installers are not code-signed yet, so the OS will block them — this is expected. Use the steps above to trust them manually.

## Run from source

Requires **Node 24** (same as CI) and npm. Windows / macOS / Linux all work.

```bash
git clone git@github.com:Yourstandby/PiForge.git
cd PiForge
npm install

npm run dev            # browser mode: http://localhost:30141
npm run dev:electron   # Electron window
```

> `dev:electron` loads the static export in `out/`. If `out/` is older than `app/ components/ lib/ hooks/ public/`, a pre-flight guard fails loudly and tells you to run `npm run build:static` first — otherwise you would keep debugging against a stale UI.
> To warn without blocking: `PIFORGE_SKIP_STATIC_FRESHNESS=1`.

Common scripts:

| Script | Purpose |
|---|---|
| `npm run dev` / `dev:electron` | Browser / desktop dev mode |
| `npm run build:static` | Next static export into `out/` |
| `npm run build:agent-host` / `build:electron` | Build the host / main process |
| `npm run dist` | Full build (static export + host + Electron + installers + smoke) |
| `npm run lint` / `npm test` | Lint / unit tests |
| `npm run smoke:agent-host` | Host startup and RPC smoke test |
| `npm run measure:prefix` | Prefix cache hit-rate measurement |

---

## Architecture

**Three processes, one pipe, no internal ports.**

<pre><code>
┌──────────────┐   preload RPC    ┌──────────────┐   named pipe   ┌────────────────┐
│  Renderer    │ ◀──────────────▶ │ Electron     │ ◀───────────▶ │  Agent Host    │
│  (Next.js)   │                  │ Main         │               │  Pi SDK / tools │
└──────────────┘                  └──────────────┘               └────────────────┘
       ▲                                  │
       └──── piforge://app (static export) ┘
</code></pre>

| Process | Responsibility | Must not |
|---|---|---|
| **Renderer** (Next.js) | Render the UI, handle interaction, send RPC over the preload bridge | Import the Pi SDK, spawn processes, read or write `~/.pi/agent/` |
| **Electron Main** | Windows, tray, updates, `piforge://` protocol forwarding | Hold business logic, bypass the host to read or write sessions |
| **Agent Host** | AgentSession, tool execution, managed processes, LTM, file authorization, sub-agents, MCP | Render UI, depend on the Next runtime |

- In a packaged build the renderer loads static assets from `piforge://app/`, and `/api/**` is forwarded by the main process to the host over a named pipe — there is no localhost port to connect to, and the CSP needs no port exception.
- The host starts by default as an `ELECTRON_RUN_AS_NODE` child process (`PIFORGE_HOST_TRANSPORT=utility` switches to Electron UtilityProcess); heap limits, env isolation and exit semantics are covered by unit tests.
- The boundary contract and the reasoning behind it live in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## Quality and verification

```bash
npm run lint     # eslint, zero errors is the baseline
npx tsc --noEmit # type check
npm test         # node:test: lib / agent-host / electron / hooks / components / scripts
```

The repository also ships smoke scripts that need no human watching: `smoke:static-fresh`, `smoke:packaged-static`, `smoke:packaged-layout`, `smoke:agent-isolation`, `smoke:extension-ui`, `smoke:host-reconnect`. Startup time, process memory and incremental tokens each have measurement scripts, and the history is kept in `docs/measurements/`.

## Repository layout

| Directory | Contents |
|---|---|
| `app/` `components/` `hooks/` | Next.js renderer: three-column shell, chat, panels and settings |
| `lib/` | Logic shared across processes: modes and tool policy, path authorization, session model, formatting |
| `agent-host/` | Agent host: Pi SDK adapter, tools, MCP, sub-agents, LTM, watchdog |
| `electron/` | Main process: windows, tray, `piforge://` protocol, named-pipe bridge, updates |
| `contract/` | Typed protocol between the main process and the host |
| `scripts/` | Build, smoke, measurement and release scripts |
| `docs/` | Architecture contract, release notes, measurement and research records |
| `bench/` | Startup and resource benchmarks |

## Documentation

- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — three-process boundaries and the communication contract
- [CHANGELOG.md](./CHANGELOG.md) — per-release "what changed / did any default change"
- [docs/releases/](./docs/releases) — release notes and install tips for each version; every note exists in English and 简体中文 ([index](./docs/releases/README.md))
- [docs/measurements/](./docs/measurements) — prefix cache, increment, startup and memory data
- [CONTRIBUTING.md](./CONTRIBUTING.md) / [AGENTS.md](./AGENTS.md) — contributing, and the engineering conventions agents must follow

## License

MIT License, see [LICENSE](./LICENSE).
