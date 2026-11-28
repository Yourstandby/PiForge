# Changelog

**English** · [简体中文](./CHANGELOG.zh-CN.md)

Entries are organized around "what changed / did any default change / how to use the switches". Detailed data lives in `docs/measurements/` (three separate lenses — a recording provider, a real deepseek session, and an A/B of repeated scenarios — do not mix them).

## v0.12.3 — event stream stuck at "waiting for the first token" (only a refresh showed content)

Theme: **the host's delivery watermark counted "delivered to a subscription nobody consumes any more" as delivered; the next round then resumed after that entry, so the segment the browser never received was lost for good. The UI sat at "waiting for the first token", and one refresh (reloading the transcript from disk) brought everything back.**

### What changed

- **No more orphan host subscriptions** (`lib/agent-host-client.ts`): while `subscribeAgent` awaited
  `agent.subscribe`, the browser could already have cancelled the SSE (`close()` removes the hub), and that
  subscription still landed — events kept flowing, nobody received them, the watermark kept rising. Now the hub
  identity is verified before and after creating the subscription; if the hub has already been removed,
  `agent.unsubscribe` runs immediately. `close()` now deletes a mapping only when it is still its own, so a
  concurrent call cannot wipe out a hub someone else just created.
- **The resume watermark counts what actually reached a listener**: `agentListenerSeq` records, per session, the
  last event genuinely delivered to an SSE listener, and it survives across hubs. Without an explicit `fromSeq`,
  resume uses it instead of blindly trusting the host's `lastDeliveredSeq`.
- **The route registers abort before creating the subscription** (`app/api/agent/[id]/events/route.ts`): a browser
  cancelling during the await can still set `closed` and release the subscription that was just created.
- **Self-healing when stuck** (`hooks/agent-session/stream-health.ts` + `components/ChatSurface.tsx`): new
  `STREAM_FIRST_EVENT_MS = 12s` plus a "real increment timestamp" (`getLastRealEventAt`; reconnect bookkeeping
  from `connect()/retryNow()` no longer pollutes the decision). When a round receives no real event at all, the
  stream is declared stuck after 12s and the UI automatically reconnects (with the browser's real watermark, so
  the host resumes from its buffer) and reloads the round's output from disk; attempts are at least 15s apart and
  capped at 4 per round. Scenarios already inside a streaming or tool turn keep the previous 120s threshold.

### Did default behavior change

- Yes: when stuck you no longer have to refresh manually or press stop; the UI recovers by itself within 12s.
- No: the event stream protocol, host-side resume semantics (resume from the last undelivered point after a Next
  restart), UI copy and switches.

## v0.12.3 — Pi core upgraded to 1.6.0

Theme: **the three upstream packages move 1.5.0 → 1.6.0, the extension render contract follows, and one long-red
smoke assertion gets fixed along the way.**

### What changed

- **`@earendil-works/pi-ai` / `pi-coding-agent` / `pi-mcp` pinned to exactly 1.6.0** (the three packages must share
  a version; upstream 1.6.0's own dependency set also pins `pi-ai` / `pi-mcp` / `pi-tui` to 1.6.0).
- **Following the breaking change in extension components**: from 1.6.0, a component's `render()` returns
  `readonly string[]`, and `Container` returns the same cached array when its children are unchanged — any code that
  mutates the result of `super.render()` in place will hit this. Audit result: PiForge has no `Container` subclass
  and no in-place mutation of `super.render()`; `agent-host/` imports upstream through exactly one seam,
  `sdk-adapter.ts`, so no code change was needed.
- **Fixing the stale watchdog assertion in `smoke:agent-host`**: the script still asserted the default
  `stallMs === 20_000`, while `agent-host/watchdog.ts` has defaulted to 90_000 since v0.12.0 and 90s is the lowest
  preset. That smoke has been red since v0.12.0 (unrelated to this upgrade); it now asserts 90_000 with the reason
  written down.
- **Restoring the CHANGELOG section v0.12.2 lost during a merge**: the `## v0.12.2` heading and the three groups of
  entries ("queued messages / plan mode / panels and caching") were deleted wholesale while resolving a conflict
  (the `Unreleased` section was collapsed into those 58 lines of v0.12.2), leaving only the orphaned "image sizing"
  items. They are restored here from the release commit's original text.
- README badges and the version in the "swappable Pi core" line now say 1.6.0.

### Did default behavior change

- No: PiForge's own watchdog default (90s), UI, tool set, switches and session directory
  (`~/.pi/agent/sessions`) are unchanged; the upgrade only swaps the runtime.
- Yes (from upstream 1.6.0): the default model of `openai` / `azure` / `openai-codex` becomes GPT-6.2 Sol (same
  price); the `find` tool's path pattern is now relative to the searched directory (`src/*.ts` no longer matches
  `pkg/src/a.ts`; cross-level matches need `**/src/*.ts`); the two GPT-6.2 tiers do not accept reasoning effort
  `none` / `minimal`, so "thinking off" is unavailable on those models.

## v0.12.3 — send path: no more "sent, but nothing happened"

### What changed

- **Hitting "still running" no longer drops the message silently**: `handleSend` returned early whenever
  `agentRunning` was true. If the previous round's `agent_end` was lost, or the frontend state lagged behind the
  host, pressing send sent nothing and showed no error. It now goes down the queue path (visible / editable /
  immediately sendable), and when the host really is idle a new round starts at once.
- **The send gate expires on its own** (`PROMPT_DISPATCH_STALE_MS = 8s`): it used to be released only on error or
  when `agentRunning` flipped to false, so a single lost event could wedge it forever and every later message was
  silently swallowed.
- **Failures stay visible**: a message the host rejects is marked `deliveryState: "failed"`, shows "not delivered"
  under the bubble, and keeps a persistent "this message was not sent: <reason>" row above the input with retry /
  dismiss. Retry first removes the optimistic bubble that never entered the session, then resends — you never end up
  with two identical messages.
- **The host no longer rejects messages during a resource reload**: `reloadResources()` changed from "throw
  `Session is reloading` when concurrent" to reusing the same in-flight promise; the hard rejection of `prompt` on
  `isStreaming || reloadingResources` narrowed to block `isStreaming` only. The config watcher can trigger a dozen
  reloads in one session, and hitting one used to lose a message.

### Did default behavior change

- No: tool set, models, session directory, watchdog thresholds, theme and layout.
- Yes: pressing send while a round is running queues the message (it used to be dropped silently); a bubble the host
  rejected carries the "not delivered" mark.

## v0.12.2 — conversations stop disappearing, queued messages are editable, plans get an ending

Theme: **running no longer looks stuck, queued messages are editable, plans no longer rot, and a connected MCP server no longer breaks the prefix cache.**

The previous public version was v0.12.1. There are no new switches in this release — everything is a behavior fix
plus two small entry points that were missing.

### What changed

**Transcript**

- **Conversation history is no longer blanked out while running**: `useSessionLoader` had two paths that silently
  called `setMessages([])` — when `fetchSession` returned null (host busy / write race) and when a re-fetch of the
  same session returned an empty `context.messages`. A running round re-fetches repeatedly, so hitting one of them
  produced permanent blankness (only `agent_end` reloads before the round ends, and that is precisely the thing that
  has not happened yet). Both cases now keep what is already on screen; while running with genuinely zero history,
  the UI explains the situation, offers "reload", and retries automatically 6 times with 1.5s→6s backoff.
- **tokens/s no longer freezes**: the rate drops to zero when thinking / streaming ends instead of hanging onto last
  second's number; the tokens/s on a tool card only shows while running and disappears the moment it finishes.
- **No more flashing "reconnecting event stream"**: after send, `agentRunning` flips to true first while
  `connectEvents` runs after an await, so that gap read the previous round's `disconnected` and leftover
  `reconnectAttempts`. The counter now resets the moment the round ends, `evaluateStreamHealth` grants a 3s grace at
  the start, and connecting / disconnected with `attempts=0` is always treated as a normal start.
- **Clickability rules unified with the visuals**: body text and inline code share `parseLinkableFileReference`; a
  bare file name (`seed.ts`) is always plain text, and only a separator or an `@` prefix makes a link. Clickable =
  accent + underline + `cursor-pointer`; not clickable = `cursor-text`. External links allow only http / https /
  mailto / tel; every other scheme degrades to plain text.
- **Image sizing collapsed into two constants**: message images (user bubbles / assistant body / markdown inline) use
  `CHAT_IMAGE_SIZE = "max-h-64 max-w-full"`, tool-produced images use `TOOL_IMAGE_SIZE = "max-h-72 max-w-full"`.
  Four places used to hardcode `max-h-64 / 72 / 80`, so the same reference image appeared in three sizes in different
  bubbles; and all of them capped height but not width — when the width derived from the height exceeded the bubble,
  the flex item (`min-width:auto`) refused to shrink and wide images were clipped sideways by the scroll container.
  Image wrappers also gained `max-w-full` / `min-w-0`.
- **One submit per 800ms of the same text** (`DUPLICATE_SUBMIT_MS`): double-clicking send, mashing Enter, or "thought
  it did not go through so pressed again" no longer produces two duplicate bubbles in the same second.
- **No more "0 produced this round" before the first token**: it now reads "waiting for the first token…" and states
  that the message reached the host.
- **Delivery state is visible**: after a steer / queued submit the bubble shows "delivering…" until the host takes it
  (`deliveryState` cleared); the state is part of the round cache's reference key, so the mark cannot stick on screen.
- **Host side**: a late or duplicate `agent_settled` with no evidence that the round ended no longer dispatches the
  next queued message; it only closes the round and hands off to the fallback retry, avoiding two queued messages
  landing in the database at the same instant.

**Queued messages**

- **Editable**: clicking the text or the pencil opens inline editing (Enter saves / Esc cancels), changing the text in
  place while keeping the id, position and attachments (previously you had to delete and retype, losing both
  attachments and order). Delete is hidden while editing to avoid accidental loss.
- **⚡ Send now**: steers during streaming, starts a new round when idle; a failed steer degrades to a new prompt, and
  if that is rejected too the message goes back into the queue unchanged.
- **⏫ Move to the front**: the host queue gained `update` / `take` / `restoreAt`; `take` returns the original index
  and a failed delivery puts the message back where it was; new commands `update_follow_up` / `expedite_follow_up`.

**Plan mode**

- **Plans are no longer shelved silently**: the old implementation returned null once "the round ended and it was not
  waiting for approval", so a plan stopped at 3/6 vanished on the spot — the user did not know what remained and the
  model would never bring it up again. Now an unsettled plan on a stopped agent gets a "not finished" label plus two
  exits, "continue" and "drop the rest"; `dropped` is a terminal state (not counted as done), and `abandonPlan`
  settles locally by planKey without spending another round.
- **Completed steps lose the strikethrough**: `done` only drops to `text-ink-muted` (4.8:1) and completion is expressed
  by a filled checkbox; `line-through` is reserved for `dropped`. When the list is expanded, finished steps collapse
  into a single "N steps done" line.
- **The card no longer lingers for 1-2s**: `livePlan` only serves the round that is running; it is cleared when the
  prompt is enqueued instead of waiting for `agent_start` to arrive — in that window `planProgress` would pass off the
  previous round's finished card as this round's progress.

**Panels and caching**

- **The fleet / orchestrator panels gained a manual spawn entry**: `AgentSpawnTrigger` (name may be left empty to
  auto-name, plus a task brief); the panel passes the current project cwd to the host; new RPC `herdr.spawn` (cwd goes
  through the file policy first); the POST handlers of `/api/herdr` and `/api/orchestrator` each accept
  `action=spawn`.
- **The `mcp_servers` section is byte-latched**: the MCP extension re-renders that section from live state every
  round; indirect servers (codemode / deferred) do not wait for a connection in the first round, and once connected
  `connection.instructions` is added to the description — any change to those bytes means the whole history misses and
  is resent. The first bytes are now latched under a signature of "server name + exposure mode" and reused while the
  signature holds; only a real configuration change (adding / removing / toggling a server) swaps them once. The load
  and discovery paths are untouched.

### Did default behavior change

- Yes: the maximum height of assistant-body / markdown inline images drops from 320 to 256, matching user bubbles; no
  conversation image overflows the bubble horizontally any more (they used to be clipped). Tool-produced images stay
  at 288.
- Yes: a plan card in "not finished + agent stopped" now stays until you press "continue" or "drop the rest".
- Yes: `tokens/s` only shows while running and drops to zero instead of freezing; completed plan steps no longer have
  a strikethrough.
- No: click-to-enlarge, lightbox zoom / pan / download, attachment preview; plan is still read-only and the approval
  flow is unchanged; the MCP load, discovery and config read/write paths are unchanged.

## v0.12.1 — plan mode no longer resends context

Theme: **switching into plan no longer burns the whole cache, and the progress card actually appears for the first time.**

### What changed

- **Entering / leaving plan no longer invalidates the request prefix**: plan mode used to change both the system prompt
  (appending a plan section) and the tool array (plan loaded in full on its own plus a narrowed declaration set);
  both live in the prefix, so the next request resent the whole history (visible as "prefix invalidated, this request
  will resend ≈N tok"). The declaration set is now decided solely by the tool preset, independent of mode, and the
  plan section is injected as a trailing `display:false` message — plan and execute produce byte-identical prefixes.
- **The read-only constraint moved to execution time**: plan mode no longer implements read-only by withholding tools;
  `tool_call` rejects writes via `PLAN_TOOLS` / `isPlanAllowedDomainCall`, with the reason `Plan mode: planning only`
  spelled out (no longer the misleading `Blocked by user`).
- **Plan progress card fixed**: tool call blocks in a session are `{id, name, arguments}`, while the folding function
  only understood `{toolCallId, toolName, input}`, so nothing ever matched in a real session and the card never
  rendered. Both shapes are accepted now. The same shape bug pushed every entry of "tool call statistics" into
  `unknown`, which is fixed too.
- **The plan tool is always declared**: it could be reduced to a stub (name only), and without a schema the model would
  not call it; it is now always present, like `tool_search` / `desktop_use_tool`.

### Did default behavior change

- Yes: **in plan mode the model can see the schema of write / edit / MCP / plugin tools**, and calls are blocked at
  execution time. This is the necessary price for whole-prefix caching — as long as declarations vary with mode,
  switching necessarily resends context.
- No: plan is still read-only; the approval flow, the plan card's position and its interactions are unchanged.

## v0.12.0 — projects belong to the user · numbers and switches tell the truth

Theme: **the left column is yours to manage, usage and the watchdog tell the truth first, injection switches state their defaults first.**

This release also ships the two versions that were never published separately (v0.11.3 / v0.11.4). The last public
release on GitHub was v0.11.2; the per-item records are kept in their own sections below, and this section only covers
what is new here plus the cross-version summary.

### What changed

**Docs and release**

- **README fully rewritten**: the Pi core version lines up with `1.5.0`, and it gained the v0.12.0 highlights, a table
  of switch defaults, the `dev:electron` static-artifact guard note and the unsigned-installer disclosure; stale
  numbers and old claims were removed.
- **`docs/releases/v0.12.0.md` added**: CI's `desktop-packages.yml` uses it as the Release Notes when no release exists
  yet, with install notes for all three platforms (SmartScreen / Gatekeeper / unsigned deb needing root).

**Developer experience**

- **`dev:electron` pre-flight guard** (`scripts/check-dev-static-freshness.mjs`, unit test
  `dev-static-freshness.test.mjs`): when `out/` is older than `app/` `components/` `lib/` `hooks/` `public/` or the
  root config, it fails loudly and tells you to run `npm run build:static`. The renderer loads the static export under
  `piforge://app/`, so rebuilding only the main process means you keep running the old UI. Tolerance is 5s;
  `--warn` or `PIFORGE_SKIP_STATIC_FRESHNESS=1` only warns.

### 0.11.3 / 0.11.4 shipped together (summary)

- **Usage tells the truth**: cost reports only accumulated real `usage`, isolated per session; streaming events are
  coalesced per frame, the tool-card stopwatch tick is localized; re-renders from typing / switching sessions /
  switching panels are pruned.
- **Injection switches in three states**: AGENTS.md / CLAUDE.md injection can be turned off (on by default), HANDOFF.md
  continuation injection is opt-in (off by default), both as "global + project-level" three-state settings; the
  compaction summary is always Chinese and by default only takes over the body.
- **Defaults**: new sessions' thinking level moves low → medium (balanced); the watchdog stall threshold goes 20s → 90s
  by default, and 90s becomes the lowest preset (presets 90 / 120 / 300 / 600 s).
- **Projects belong to the user**: left-column projects can be renamed and hidden from the sidebar (writes only the
  `pi-sidebar-projects-v1` local preference, deletes no session and touches no directory).
- **Call budget by batch**: prompt and runtime guard now say "1 batch for simple / 2–3 for ordinary / 3–4 for research",
  with at most 12 parallel calls per batch; at the ceiling, deliver conclusions first.
- **Ask before closing the window**: a native dialog offers "minimize to tray / quit", with a remember-my-choice
  option; the tray can change it back at any time.
- **Usage number abbreviation**: exact below 1000, one decimal at or above (`2.9K` / `69.8K`), carries to `1.0M` at
  ≥ 999,950.
- **Pi core 1.5.0**: the three `@earendil-works/pi-*` packages pinned exactly, with the `clientRegistration` type
  adapted; tool argument validation now runs in upstream `pi-schema` (all our tools are plain JSON Schema, so behavior
  is unchanged).

### Did default behavior change

- **Yes** (the five most visible when upgrading straight from 0.11.2): the watchdog goes red at about 100s instead of
  about 25s and can no longer go below 90s; new sessions default to balanced thinking; closing the window now asks;
  projects can be renamed / hidden; the usage strip shows only real usage (during streaming, no number means no number).
- **No**: the three-process boundary, zero internal ports, the file authorization chain, codemode defaulting to
  `only`, themes and layout.

### Verification

- `npm run lint` → 0 errors / 8 warnings (all pre-existing unused-variable and hook-dependency warnings).
- `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit` → passes.
- `npm test` → 1599 items, 1595 passed / 0 failed / 4 skipped.

## v0.11.4 — projects can be renamed and hidden · the watchdog watches long jobs

Theme: **the left column's projects are yours to manage, and the watchdog stops killing long jobs by mistake**. Four things: rename / hide projects, watchdog stall threshold defaulting to 90s with 90s as the floor, usage numbers abbreviated above one thousand, and Pi core moving to 1.5.0.

### What changed

**Left-column projects**

- **Rename a project** (`components/session-sidebar/ProjectGroup.tsx`, `components/SessionSidebar.tsx`): the `⋯` at
  the end of a hovered row, or a right-click on the project row → "rename project"; an inline input submits on Enter
  and cancels on Esc. Only the displayed name in the left column changes; the directory on disk and session ownership
  stay put. An empty name or the original folder name restores the default.
- **Remove from sidebar** (same files): "remove from sidebar" takes the project out of both the regular area and the
  "other projects" folder. It writes a single local preference (`hiddenProjects` in `pi-sidebar-projects-v1`), deletes
  no session and touches no directory; picking the same directory again with "new project" restores it.
- Custom names persist in the same place (`projectNames`), validated item by item on parse with invalid values dropped
  (`components/session-sidebar/projects.ts`).

**Watchdog**

- **Stall threshold defaults to 90s, and 90s is also the floor** (`agent-host/watchdog.ts`): default 20s → 90s, runtime
  floor 5s → 90s (a smaller value passed to `watchdog.configure` is clamped to 90s, the upper bound stays 10min). The
  scan period is still 5s with two consecutive over-threshold scans to escalate, so by default it goes red after about
  100s without meaningful progress.
- **Dropdown presets are now 90 / 120 / 300 / 600 seconds** (`hooks/useWatchdogStatus.ts`); older locally stored values
  (15/30/60s) are clamped into the new range on read, so the panel never shows a number the host will rewrite.

**Usage**

- The two usage lines and "produced this round": exact integers below 1000, one-decimal abbreviation at or above
  (`2.9K` / `69.8K`), carrying to `1.0M` at ≥ 999,950. The rules are centralized in `lib/token-format.ts`.

**Pi core**

- `@earendil-works/pi-*` 1.4.0 → 1.5.0 (pinned exactly; transitive dependencies gain `pi-schema`). Upstream breaking
  changes (tool arguments validated by pi-schema, pi-ai no longer exposing TypeBox) do not affect PiForge: we never used
  `Type.Refine` / `BigInt` / `Undefined` / codec-defined tool arguments. The only adaptation is in
  `agent-host/mcp-service.ts`, where the `clientRegistration` type widens with upstream to `"auto" | "dcr" | "cimd"`
  (that field does not participate in PiForge's own loopback login flow).

**Developer experience**

- **`dev:electron` frontend-artifact guard** (`scripts/check-dev-static-freshness.mjs`,
  `scripts/lib/dev-static-freshness.mjs`, unit test `dev-static-freshness.test.mjs`): when `out/` is older than `app/`
  `components/` `lib/` `hooks/` `public/` or the root config, it fails and exits, telling you to run
  `npm run build:static`. The renderer loads the static export under `piforge://app/`, and `dev:electron` only rebuilds
  the main process and agent-host, never the export — without a rebuild you keep running the old UI (that is exactly
  how this round's rename / remove work was misjudged as "not implemented"). Tolerance is 5s, ignoring unit tests,
  docs, build artifacts and dependencies; `--warn` or `PIFORGE_SKIP_STATIC_FRESHNESS=1` only warns.

### Did default behavior change

- **Project names and visibility**: no. Old data has neither field → shown as before, unless you rename or hide it.
- **Watchdog**: yes. The default red light moves from about 25s to about 100s and cannot be set below 90s again. If you
  want it even more forgiving, choose 120 / 300 / 600 seconds.
- **Usage numbers**: display only; billing semantics are unchanged.
- **Pi core**: interfaces and behavior unchanged; tool argument validation now runs in pi-schema (all our tools are
  plain JSON Schema).
## v0.11.3 — usage tells the truth · injection and budgets tightened

Theme: **numbers tell the truth first, switches state their defaults first**. The main area fixes "inflated usage strip / streaming jank", the settings side tightens prompt injection into "global + project-level three-state", and a few defaults are adjusted.

### What changed

**Usage and rendering**

- **Cost reports only accumulated real usage** (`lib/live-usage.ts`, `components/UsageStrip.tsx`): the estimate added
  during streaming is gone; without `usage` there is no number.
- **Live usage is isolated per session** (`components/ChatSurface.tsx`): another session running no longer adds to the
  current session's usage strip.
- **Streaming events are coalesced per frame** (`hooks/useAgentSession.ts`, `components/Transcript.tsx`): increments
  within one frame are committed once; the tool-card stopwatch tick is localized instead of re-rendering the whole tree.
- **Re-render pruning** (`components/Workbench.tsx`, `SessionSidebar.tsx`,
  `components/session-sidebar/SessionTree.tsx`): jank from typing / switching sessions / switching panels is addressed.

**Defaults and prompt injection**

- **Thinking level defaults to medium** (`agent-host/settings-defaults.ts`, `lib/thinking-level.ts`): new sessions
  default from low to "balanced".
- **The compaction summary is always Chinese and more concise** (`agent-host/compaction-plan.ts`): by default it only
  takes over the summary body.
- **Context file injection switches** (`lib/project-settings.ts`, `agent-host/rpc-manager.ts`): AGENTS.md / CLAUDE.md
  can be turned off, global + project-level three-state (follow global / on / off), **on by default**.
- **HANDOFF.md continuation injection** (`lib/handoff.ts`): a HANDOFF.md at the project root or under `docs/` can be
  injected into the system prompt, **off by default**.

**Interface**

- **The dev-environment switch became a status pill** (`components/DevEnvironmentConfig.tsx`): the slider geometry is
  gone, eliminating overflow at small sizes completely.

### Ask before closing the window: "minimize to tray / quit"

#### What changed

- **Main window close** (`electron/main.ts`): clicking X no longer hides silently but opens a native dialog —
  "minimize to tray / quit"; ticking "remember my choice" stops the asking. Esc or dismissing the dialog always
  minimizes, so the process is never killed by accident.
- **Preference file** (`electron/close-preference.ts`): `<userData>/close-preference.json`, values
  `ask | minimize | quit`, falling back to `ask` when corrupt or invalid. Kept separate from
  `agentDir/desktop-settings.json` — after packaging, main only has `electron/dist` and cannot import `lib/`.
- **Tray menu** (`electron/tray.ts`): radio items under "when closing the window" (ask every time / minimize to tray /
  quit), changeable at any time without hand-editing the json.

#### Did default behavior change

- First run (no preference file) → every close asks, unlike 0.9.x's silent hide.
- Choosing "quit" goes through the normal quit flow (`before-quit` → host drain → child process tree reaped), not
  `app.exit(0)`, so there are no orphan dev servers.
- "Quit" in the tray icon still quits directly without asking.

#### Verification

- `npx tsc -p electron/tsconfig.json --noEmit` passes;
- `node --test electron/close-preference.test.ts` 6/6 passes;
- `npx eslint electron/{main,tray,close-preference}.ts` reports nothing.

#### Call budget changes from "count" to "batches"

Theme: **batching calls is the actual speed-up**. Multiple tool calls in one assistant message already run in
parallel in pi, and wall-clock time is decided by round trips; budgeting by call count only forces the model to stop
mid-batch and start a new round that resends the whole context.

##### What changed

- **Prompt** (`agent-host/prompts/output-style.ts`, `BATCHING_RULES` 7 → 8 items): new "batch calls (first priority)"
  and "do not mix writes into a batch"; "call budget (hard-coded)" reworded in batches (1 for simple / 2–3 for
  ordinary / 3–4 for research, at most 12 parallel per batch); "self-check at call 4" became "self-check after each
  batch".
- **Runtime guard** (`agent-host/desktop-tool-guard-extension.ts`): `TURN_BUDGET` 4/8 → 12/24 (self-check after about
  one full batch, wrap up after about two), `DEFAULT_TOOL_GUARD.maxParallel` 8 → 12, and both reminder strings reworded
  in batches.

##### Did default behavior change

- The soft constraint is unchanged: still "deliver a verifiable conclusion at the ceiling, leave the rest of the todo
  for the next round" — only the thresholds scale with batch size.
- No new switches; `PIFORGE_TOOL_MAX_PARALLEL` still overrides the per-batch parallel limit.

- **Prefix budget** (`scripts/smoke-prefix-budget.mjs`): `--max-prefix` 7600 → 7660. The first wording pushed the
  prefix to 7774 as measured in CI (token guards red); after tightening it came back to 7585; 7660 = measured + ~1%
  headroom. Note that the local Windows sys section is about 430 tok larger than in CI, so this smoke goes red locally
  — trust the CI numbers.

##### Verification

- `node --test --test-force-exit agent-host/desktop-tool-guard-extension.test.ts agent-host/desktop-output-style-extension.test.ts` → 21/21
- `npx eslint` (the four changed files) → no output

## v0.11.2 — sessions bucketed by time (counts and content from one source)

Theme: **what you open is what you see, and numbers tell the truth first**. The sidebar no longer reveals sessions piecemeal through "show all / load more" but files them into time buckets, and the collapsed header shows the real count you get when you open it.

### What changed

- **First screen fetches everything at once** (`lib/sessions-cache.ts`): `SESSION_PAGE_SIZE` 20 → 200 (the server-side
  single-request cap). Pagination remains only as a fallback for the extreme case of "more sessions than one page" and
  no longer drives scroll loading.
- **Time buckets** (`components/session-sidebar/date-groups.ts` rewritten): today / yesterday / the past 7 days by day,
  within 12 months by calendar month (`October 2026`), older by calendar year (`2025`); unparseable timestamps go to
  "unknown time" at the very end. The `older` bin is gone — month and year dimensions are no longer erased in the data
  layer.
- **Counts count root sessions only**: `SessionDateGroup.count` comes from the same source as `nodes`, so branch
  sub-sessions are not counted twice.
- **Only today / yesterday expand by default**; the rest are collapsed. Expanding is pure `setState` — no request, and
  never an empty one.
- **Three fighting mechanisms removed**: `autoLoadPaused` (which silently stopped scroll loading whenever any project
  sat in preview state, so scrolling to the bottom did nothing), the scroll sentinel, and the "show all N" button.

### Did default behavior change

The number of sessions visible by default goes from "5 per project" to everything within one page, visible on
collapse — an **intentional default change**. "Load older sessions" only appears at the bottom when the total exceeds
one page; it shows no number, because the server's `total` includes temporary piforge-probe / ab-control sessions under
`%TEMP%` and would be a fake number.

### Verification

- `npx tsc --noEmit` passes; `npm run lint` passes;
- `node --test components/session-sidebar/*.test.ts lib/session-reader.paging.test.ts lib/sessions-cache.test.ts` → 27/27;
- Measured `/api/sessions?limit=200`: about 400ms cold, 23ms once the info cache is warm.

## v0.11.1 — paste lag / stopwatch / stream health / project isolation (off by default)

Theme: **fixing the three "looks stuck" spots 0.11.0 missed**, plus a project-level file isolation that is off by default. Call budget and tool defaults are untouched; the content of `v0.11.0` is preserved by merging the `v0.11.0` tag.

### What changed

- **Pasting images no longer blocks the main thread** (`lib/image-attachment.ts`): scaling goes through
  `createImageBitmap`'s resize options (decode + resample on a worker thread) and the main thread only moves small
  images; transparency is probed with a 24×24 sample, only genuinely transparent images stay PNG (the rest are JPEG at
  0.92), GIF/SVG are sent as-is; a 160px thumbnail `previewUrl` and a downsampled full image `fullUrl` are generated,
  and the `ImageBitmap` is explicitly `close()`d.
- **Paste interaction** (`components/Composer.tsx`): a "processing" placeholder is inserted synchronously, multiple
  images are handled serially with one frame yielded per image, sending is blocked while processing, and both object
  URLs are revoked on remove / send / unmount.
- **Tool-card stopwatch** (`lib/tool-clock.ts` / `components/Transcript.tsx`): duration is finalized from
  `tool_execution_end` and frozen on completion instead of counting along with the latest call.
- **Stream health** (`hooks/agent-session/stream-health.ts` + `components/StreamHealthBanner.tsx`): distinguishes
  `reconnecting` / `failed` / `stalled` (30 s with no real increment) and says plainly when the event stream breaks
  instead of sitting at "PiForge is thinking…".
- **Project isolation** (new switch, off by default): `projectIsolation` in `desktop-settings.json`; the host's
  `authorizePath(target, op, scope?)` requires the path to be inside the current project when enabled, and fails closed
  without a current project; new RPC `files.setScope` + Next route `/api/files/scope` (Workbench reports the active cwd),
  with `file-index` / `git` / `statusline` / `processes` each treating cwd as their scope.

### Did default behavior change

Only one new switch, and it is **off by default**: with "project isolation" not enabled, file authorization behaves
exactly as in 0.11.0.

## v0.11.0 — call budget and jank tightened up (tool overhead / codemode / UI timing / smoke scripts)

Theme: **turning "stuck" into visible numbers**. The per-user-turn tool call budget is hard-coded (<8 calls, self-check at the 4th), fixed tool overhead is compressed overall, codemode returns to declaring tools one by one and reports in-script progress, the UI fixes "clicked and nothing happened", "scrolling up yanks me back" and "the tool card keeps ticking", and measurement / smoke scripts no longer hang silently.

### What changed

- **Call budget**: `BATCHING_RULES` split into "call budget (hard-coded)" and "mid-run self-check" (simple ≤4 / ordinary
  ≤8 / research ≤10, self-check at call 4, no `du -sh` and no full `grep -r`, `timeout 30`); tool-guard gained
  `TURN_BUDGET` + `createTurnBudgetTracker()`, appending a reminder at calls 4 and 8, reset on `before_agent_start`,
  with nested codemode calls not double-counted.
- **Tool overhead**: the output budget default goes 4000 → 24000 characters (9000 from each end, 400 lines, the `read`
  tier not scaled, second trimming idempotent); timeouts go 120/900 → 45/300 s; scheduler heavy slots 4/2 → 6/4.
- **codemode**: pool size configurable (settings page > `PI_CODEMODE_MAX_WORKERS` > 2); default mode `only` → `on`;
  in-script call progress is folded into one line and returned through liveOutput; on timeout / cancellation the
  observation extension logs an inferred `slot held (pool=N)`; hotfix scripts for packaged builds ship as
  `scripts/hotfix/hotfix-codemode.{ps1,sh}`.
- **Interface**: a tool card's duration freezes on completion (`lib/tool-clock.ts`, a module-level Map keyed by
  `toolCallId`, preferring pi's `durationMs`); tab switching / sidebar session clicks commit synchronously (the
  `startTransition` that streaming updates kept interrupting is gone); the scroll listener's deps gain
  `showTranscript` and smooth scrolling becomes `behavior:'instant'`; intervention text gets a `[system prompt]` prefix
  and renders as a gray system card that stays out of turn navigation.
- **Session sidebar**: the first screen adds each project's newest session and returns a `nextOffset` cursor, so
  historical project groups no longer vanish wholesale.
- **Scripts no longer hang silently**: a 60 s hard deadline waiting for frames, immediate rejection on host exit /
  disconnect with the exit code folded into the error (`HOST_EXIT_GRACE_MS=700`); new
  `scripts/lib/host-spawn.mjs` (`spawnNodeHost` / `hostChildEnv`) with 12 scripts moved onto the factory and the stdin
  guard written in one place; `smoke:prefix-budget` prints progress per step and has a hard timeout
  (`PIFORGE_SMOKE_STEP_TIMEOUT_MS`, using `taskkill /F /T` on Windows).

### Did default behavior change

Yes, in five places: codemode defaults to `on` (tools declared one by one); shell calls without `timeout` are
interrupted at 45 s (300 s for heavy ones); the output budget is 24000 characters; the soft cap per user turn is 4 and
the hard cap 8 (reminders appended to the result only, nothing blocked); the scheduler's heavy quota is 6 / 4.

### How to use the switches

- Output budget `PIFORGE_TOOL_OUTPUT_CHARS`; timeouts `PIFORGE_TOOL_GUARD=0` or `PIFORGE_TOOL_TIMEOUT_*`; scheduler
  `PIFORGE_TOOL_SCHEDULER=0` or `PIFORGE_SCHED_*`.
- The codemode mode and worker pool cap are in the settings page under "extensions and MCP → Codemode" (the latter
  also via `PI_CODEMODE_MAX_WORKERS`).
- Debug logs `PIFORGE_DEBUG_TOOL_GUARD=1` / `PIFORGE_DEBUG_TOOL_SCHEDULER=1`.
- Full notes in [`docs/releases/v0.11.0.md`](docs/releases/v0.11.0.md).

## v0.10.0 — boundaries tightened (branches / queue / watchdog / tool scheduling and timeouts)

Theme: **clicking should react**. The frontend removes "clicked and nothing happened" and "clicked and had to wait" one by one; the host side gains a tool execution scheduler and a hard shell timeout guard. Three default-behavior changes are listed under "did default behavior change".

### What changed

- **Branches**: the dropdown uses `getBranches`'s full graph (the old implementation relied on `tree`, which only holds
  the current path, so `hasBranch()` was always false); multiple root `.jsonl` files are merged into a virtual root
  before deciding branching; switching branches can tick "distill the branch being left"
  (`navigateTree(target, { summarize: true })`, with the conclusion reattached to the target node as `branch_summary`
  without breaking the prefix cache); branching / forking is disabled during streaming with a stated reason, and failures
  no longer go only to the console.
- **Queued messages**: deletable (red on hover); the host dequeues by revision, the frontend updates optimistically and
  refetches on conflict.
- **Watchdog**: `agent.intervene` accepts synchronously and returns a receipt immediately while delivery runs in the
  background; on a forced skip, a tool already running >10 s gets `abortBash()` first, then delivery; the stall marker
  points only at the line that is really stuck (`stuckToolCallIds`); the verdict bar is not rendered when `verdict` is
  missing (compatible with older hosts).
- **File authorization uses its own RPC connection** (`lib/host-files.ts` + `__piforgeFilesHostClient`): no longer
  shares the main connection with agent events, so files can be clicked while tools run.
- **Tool execution scheduler** (`agent-host/desktop-tool-scheduler-extension.ts`, on by default): global heavy 4 /
  light 12, per-session heavy 2 / light 6; over-quota calls queue inside that call's `tool_call` hook; after waiting
  60 s without a slot the call gives up on queuing and runs normally, forced reclamation at 15 min, cleared on
  `session_shutdown`; codemode / tool_search / nested calls are exempt.
- **Hard shell timeout guard** (`agent-host/desktop-tool-guard-extension.ts`, on by default): the `tool_call` stage
  fills in `input.timeout` (120 s ordinary, 900 s heavy, caps 600 / 900); invalid values are corrected rather than
  thrown; when a batch runs more than 8 in parallel, only the first over-limit call in that batch gets a reminder at the
  end of its result.
- **Prompt**: `BATCHING_RULES` gains "at most 8 parallel in one batch" and "pass `timeout` explicitly for heavy
  commands"; exploration becomes "`rg -l` first for file names, then targeted `read`". Still a static constant, +26
  characters on the prefix.
- **Measurement**: `npm run measure:prefix -- --summary` prints at most 10 decision numbers.
- **Packaged host loaded no extensions (severe)**: the single-file bundle missed the Pi SDK's `PI_BUNDLED_NODE` define,
  so the SDK thought it was running in an unbundled dist tree and resolved aliases by bundle path, loading
  `~/.pi/agent/extensions/*` and swallowing the failures — the host was ready and every RPC worked, but not one user
  extension took effect (since v0.9.2). Fixed, with a `smoke:extension-ui-bundled` guard added; `dist` / `pack` also
  gained `smoke-packaged-standalone` (previously only macOS ran it).

### Did default behavior change

Yes, in three places:

1. A shell call without an explicit `timeout` is interrupted at 120 s (900 s for heavy ones); long-lived processes and
   full packaging must pass `timeout` explicitly.
2. Parallel tool calls within one host now queue against the global and per-session quotas (execution is delayed only;
   arguments and results are unchanged).
3. No individual feature changed: the branch dropdown's added visibility is a bug fix; the distillation switch is still
   **off by default**.

### How to use the switches

- Turn off the scheduler: `PIFORGE_TOOL_SCHEDULER=0`; quotas and waiting go through `PIFORGE_SCHED_*` (`GLOBAL_HEAVY` /
  `GLOBAL_LIGHT` / `SESSION_HEAVY` / `SESSION_LIGHT` / `MAX_WAIT_MS` / `QUEUE_HINT_MS` / `MAX_HOLD_MS`).
- Turn off the timeout guard: `PIFORGE_TOOL_GUARD=0`; thresholds go through `PIFORGE_TOOL_TIMEOUT_SECONDS` /
  `PIFORGE_TOOL_TIMEOUT_HEAVY_SECONDS` / `PIFORGE_TOOL_TIMEOUT_MAX_SECONDS` / `PIFORGE_TOOL_MAX_PARALLEL`.
- Distillation: the switch in the branch dropdown, stored in `localStorage["piforge:branch-distill"]`.
- Full notes in [`docs/releases/v0.10.0.md`](docs/releases/v0.10.0.md).

## v0.9.4 — call compaction (tool call count / thinking budget)

Theme: **fewer round trips for the same task**. No tools removed, no capability reduced — only the number of model round trips and the share of output spent thinking are compressed.

### What changed

- **codemode is on by default, and defaults to `only`** (`lib/desktop-settings.ts`): ordinary tools are no longer
  declared to the model; they are called in one batched script instead (delivered by
  `createCodemodeExtension({ mode })`, and **not** written to `~/.pi/agent/settings.json`). The
  `agent.updateCodemode` contract gains an optional `mode`; a change in the settings page takes effect on the next
  message (the SDK reads `getMode` lazily).
- **Four new batching / budget constraints in the prompt** (`BATCHING_RULES` in
  `agent-host/prompts/output-style.ts`): batching first, quote before re-testing, call budget (≤15 model calls / ≤45
  tool calls, deliver conclusions before asking when near the ceiling), read the whole traceback before changing code.
  Static constants, entering the prefix once.
- **Truncation continuation guidance rewritten** (`agent-host/tool-output-budget.ts`): from "read it in pieces with
  grep/sed" to "read it in one codemode script batch, or page with `tool_history_get`". It only appears when something
  was truncated, so steady state costs nothing.
- **The host writes `defaultThinkingLevel: "low"` on first start** (`agent-host/settings-defaults.ts`): once, only when
  the key is missing, with an atomic write and a parse failure aborting it; change it back in the regular settings
  afterwards. `thinkingBudgets` is not written — pi's low budget is 2048 anyway.

### Did default behavior change

Yes, in three places: new sessions go through codemode by default (it can be turned off, or set back to "declare tools
as usual", in "extensions and MCP → Codemode"); new sessions default to thinking level low (changeable in the regular
settings); the first start writes one `defaultThinkingLevel` line. The tool set, approval policy, tool output budget and
`onDemandDomains` are untouched.

### How to use the switches

- Turn off the batching layer: set the "extensions and MCP → Codemode" switch to off (tools are called directly again,
  scripts still work).
- Want tools declared as usual without `only`: pick "declare tools as usual" on the same page (`codemodeMode: "on"`).
- Thinking budget: regular settings → default thinking level (written back to `~/.pi/agent/settings.json`).

## v0.9.4 — night mode

### What changed

- The regular settings gain "night mode": follow system / light / dark, written to `localStorage["pi-theme"]`;
  `<html data-theme>` + `color-scheme` are applied first by an inline boot script (no flash), and
  `components/ThemeBoot.tsx` corrects them on mount and watches `prefers-color-scheme` when set to "follow system".
- `app/globals.css`: a new `:root[data-theme="dark"]` token group (`--color-*` plus the older `--bg/--text` series);
  hardcoded light literals in the rules are replaced with tokens; literals such as `bg-white` / `bg-[#hex]` in older
  components are caught by a mapping table at the end of the file (generated by `scripts/gen-dark-remap.mjs`).
- Two hardcoded light spots fixed along the way: `explorerTokens` in `components/FilePanel.tsx` (it overrode global
  tokens inline, leaving the file tree with dark text in night mode) and the empty-session canvas in `ChatSurface`,
  which now uses `--empty-canvas`.

### Did default behavior change

No: the default is still light frost-blue (following the system preference when set to `system`). Ignore the setting if
you do not want night mode.

## v0.9.2 — agent-host cold-start bundle · context hard cap scales with the window

Theme: **cold start back from 32s to the sub-second range**. The host is bundled into a single file, and the context budget now follows the model window.

### What changed

- agent-host is bundled into a single esbuild file (`agent-host/bundle/host.mjs`): cold start no longer parses 5,917 ESM
  modules one by one (module graph load 3.1–3.5 s → 0.70–0.74 s). A missing bundle falls back to the per-file tree.
- Zero-dependency phase timings added (`agent-host/host-phases.ts`, `[agent-host] [phase] <name> ms=<n> delta=<n>`);
  `bench/startup_stats.py` parses `main.log` into p50/p95 and a phase table per start.
- **Compaction defaults back to pi**: PiForge's own desktop compaction extension is no longer registered; triggering and
  summarizing both go through pi's native `shouldCompact` + `DEFAULT_COMPACTION_SETTINGS` (reserve 16k / keepRecent
  20k). The self-built "window / budget / hard cap" triggers only take over when `PIFORGE_DESKTOP_COMPACTION=1`; the
  code and unit tests are kept, ready for A/B at any time.
- The budget hint changes from a percentage to `used / window tokens`, whose denominator is the model window alone and
  includes no compaction cap.
- The message area's lazy rendering moves to a dual-threshold hysteresis (hydrate 1200px / unmount 2000px — a single
  threshold oscillates at the boundary), scroll-up locks the sticky-bottom takeover, and it is only released when the
  real distance from the bottom is < 40px.

### Did default behavior change

- Tool names, argument shapes, the UI protocol, the session file format and the `Startup timing:` field names are all
  unchanged.
- Default compaction is **entirely decided by pi** (window − 16k reserve, keeping the last 20k tokens); PiForge no
  longer has any absolute token cap and no longer preempts `session_before_compact` to rewrite the summary.
- Packaged output gains one `resources/standalone/agent-host/host.mjs` (about 15 MB); `standalone/node_modules` stays
  (Next standalone and user extensions still use it).

### How to use the switches

- Back to the per-file entry point: delete `agent-host/bundle/host.mjs` and rerun `npm run build:standalone` — it falls
  back automatically.
- Rebuild just the bundle: `npm run bundle:agent-host`; measure only startup: `python bench/startup_stats.py`.
- `PIFORGE_DESKTOP_COMPACTION=1` → back to the self-built compaction triggers (3-round window / 45% budget / 120k hard
  cap + four-part summary); unset = delegate to pi's native policy.

### Numbers

| Item | Before | After |
| --- | --- | --- |
| host ready (from app ready) | 2670 / 2796 ms | **1194 / 1064 / 867** → p50 1064, p95 1194 |
| ESM module graph load | 3.1–3.5 s (5,917 files) | 0.70–0.74 s |
| UI interactive (static app url loaded) | p50 982 ms | p50 785 ms |
| Fresh copy + fresh userData first start (G2 proxy) | — | 1799 ms |
| Unit tests | — | 1,398 items: 1,394 passed / 0 failed / 4 skipped |

The detailed phase table and before/after comparison are in `docs/releases/v0.9.2.md` and
`docs/optimizations/host-cold-start-bundle.md`.

## v0.9.1 — sub-agent turn valve fixed · output contract · Pi core 1.4.0

Theme: **sub-agents are no longer declared dead after two turns**. Only the valve, the settlement order and the failure response change; the parallel architecture and the prompt contract stay.

### What changed

- The sub-agent turn limit goes **3 → 6** (`PIFORGE_SUBAGENT_MAX_TURNS` overrides), the predicate is fixed to
  `used <= maxTurns` so only turn `maxTurns+1` is blocked, and settlement is reordered to "idling → context → turns"
  so progress-guard gets a chance to act.
- The `ok:false` response becomes a structured `need_help` (turns / last_action / reason / next_steps) instead of a bare
  `Cancelled`.
- The sub-agent output contract is fixed: `patch` must be a diff that `git apply` accepts; JSON only constrains the
  final reply; `PIFORGE_SUBAGENT_PROMPT=legacy|contract` (default `contract`) rolls back.
- Pi core `@earendil-works/pi-*` 1.1.0 → 1.4.0 (pinned exactly); interface adaptation stays entirely in
  `agent-host/sdk-adapter.ts`.
- A weekly auto-upgrade radar is added: `.github/workflows/pi-auto-upgrade.yml` (opens PRs only, never releases).

### Did default behavior change

- Prefix 6,640 tok (clean baseline 6,240, this machine with `~/.agents/skills`), 11 tools and the core four at 710 tok
  are all unchanged.
- The sub-agent default contract changes from "prose + 3 turns" to "appliable patch + 6 turns" — the only noticeable
  default change in this release.

### How to use the switches

- `PIFORGE_SUBAGENT_MAX_TURNS=3` → back to the old limit; unset = 6.
- `PIFORGE_SUBAGENT_PROMPT=legacy` → back to the old prompt; unset = contract.
- The persistent fleet (`herdr_*`) is not subject to the limit (`maxTurns = null`).

Detailed notes and verification data are in `docs/releases/v0.9.1.md`.

## v0.9.0 — zero-token watchdog · human intervention · usage strip

Theme: **stuck is visible, intervention is one click**. Monitoring and intervention live entirely in the program layer and issue no LLM requests; the three hard numbers — prefix, core four, hit rate — are unchanged.

### Added

- **No-progress watchdog**: `agent-host/watchdog.ts` + `progress-tracker.ts`, a timer plus an in-memory state machine,
  **zero model calls, zero prompt injection** (notifications only enter an in-memory ring queue, and `watchdog.status`
  is read back to the UI only). Two rulers: `lastActivityAt` (meaningful progress: a successful, non-duplicate action or
  a body increment) and `lastLivenessAt` (signs of life, including tool starts and streaming output); under concurrency
  each tool has its own record keyed by `toolCallId`. **Default behavior changed: on by default**
  (`PIFORGE_WATCHDOG=0` turns it off completely).
- **Human intervention (HITL)**: `agent.intervene` with three actions `skip` (force skip) / `ask_brief` (minimal
  question, default) / `ask` (deep diagnosis), reusing the existing steer → front-of-queue → prompt paths without adding
  a direct model connection. **Default behavior unchanged**: no instruction is emitted unless you press the button.
- **Right-side "system monitor" panel** (`components/watchdog/`): heartbeat, per-tool timing, suspected blockers,
  backoff notifications, JSON details, a stall-threshold dropdown; plus three read-only status lights (session list /
  tab bar / tool cards). **Default behavior changed: the panel gains one tab** (the others are unchanged).
- **`UsageStrip`**: tokens / cache hits / context occupancy / upstream quota sit permanently under the input; opening it
  is still the original "usage and quota" dialog. **Default behavior changed: the statistics moved from the bottom bar to
  under the input** (position change only; the bottom bar keeps the mode and project name).
- **Overlay sidebar on narrow viewports**: at ≤ 1080px the left and right columns become overlays collapsed by default.
  **Default behavior changed: narrow windows only**; wide windows keep the three permanent columns.

### Changed

- Upstream quota is requested once: `ChatSurface` fetches it and passes it down by props to the usage strip and the
  dialog (the bottom bar and the dialog used to fetch it separately); `useUpstreamUsage` also gains an
  `options.enabled` switch for later use (no caller passes false today). **Default behavior unchanged**, just one fewer
  same-origin request.
- The thinking tier menu goes 3 → 4 (`auto` / `high` / `medium` / `low`), no longer filtered by model capability, with
  unsupported tiers converged by the backend. **Default behavior changed: the menu gains "low quality (low)"**; older
  sessions persisting `off/minimal/xhigh/max` still display normally.
- Session status light priority: watchdog red (stalled) > running blue > waiting for action amber > background done
  green. **Default behavior unchanged**, the light just turns red when stalled.
- The stall threshold can be switched at runtime from the panel (15 / 30 / 60 / 90 seconds), writing only the host's
  in-memory config: no timer rebuild, no task reset, no notification (the host clamps to 5s–10min).

### Fixed

- The image lightbox's "copy" always failed before: Chromium/Electron's `clipboard.write` only accepts `image/png`, so
  the current image is now redrawn to PNG before writing to the clipboard.
- The lightbox shows the original image (`previewUrl`) instead of the downsampled version sent to the model (long edge
  1568), so large images are no longer blurry.
- In the lightbox's context menu, `Esc` closes the menu before the viewer; the toolbar makes room under the Electron
  window drag strip (with per-platform spacing for Windows/macOS).
- **Other / guards**: `smoke:agent-host` gains assertions for `watchdog.status`, `watchdog.task` and
  `agent.intervene` (default threshold 20s, invalid action rejected, unknown session rejected); `prefix-measure`
  supports an `anthropic-messages`-shaped probe (cache breakpoint verification); new unit tests for the watchdog /
  intervention / progress tracking / panel / routes.

### Migration

- **No mandatory action**. The default prefix, core four, declared tool count and hit rate are all unchanged (see the
  table below).
- To go back to v0.8.2 behavior exactly: `PIFORGE_WATCHDOG=0` (no timer, no state recorded, `watchdog.status` returns
  only `{ enabled: false }`) plus `PIFORGE_ON_DEMAND_DOMAINS=0` (all tools resident, prefix back to 6,988).
- **v0.8.3 was never released separately**; its work (tool merge 23 → 12, on-demand domains, result deduplication, cache
  warming) ships with this release, and its migration notes are in the v0.8.3 section below.
- **Not in this release**: the uncommitted auto-update work in the workspace (`electron/app-update*`,
  `auto-update-controller`, `hooks/useAppUpdater`, `components/AppUpdateRow`) and frame coalescing
  (`hooks/agent-session/frame-coalescer.ts`) are still WIP, did not enter v0.9.0, and have no default switch.

### Numbers (identical to v0.8.3, no regression)

| Item | v0.8.3 | v0.9.0 (default) | Lens |
| --- | --- | --- | --- |
| Static prefix | 6,244 | **6,244** (6,240 remeasured with the recording provider; ±4 is repository doc volume) | recording provider |
| Declared tools | 11 (`shell` on demand) / 12 (all resident) | **11 / 12** (unchanged) | `measure:prefix` |
| Core four | 710 tok | **710 tok** | `measure:prefix` |
| Stable-segment hit rate | 99.5% / 97.98% | **99.5% / 97.98%** | recording / real deepseek 30 turns |
| Auto compaction | off | **still off** | `rpc-manager.test.ts` |

### Verification

- `npx tsc --noEmit` 0 errors; `npm run lint` 0 errors (4 warnings).
- `npm run smoke:prefix-budget` exits 0 (default 6,240 / 11 tools / core 710; cacheRead hit 99.5% across 3 turns).
  A caveat on the lens: if `HOME` contains `~/.agents/skills`, the `<skills>` section enters the system prompt (+1,598
  characters ≈ +400 tok → prefix 6,640), which is an environment difference, not a code regression; the table above uses
  the lens with the skills directory emptied.
- `npm test` 1,253 items: 1,248 passed, 3 skipped by platform. Another 2 failures sit in **untracked WIP tests**
  (`electron/auto-update-controller.test.ts` importing without the `.ts` suffix, and `lib/agent-host-client.test.ts`
  waiting for a handshake retry that is not implemented yet); they are not part of this release's changes.

## Unreleased — v0.8.3 (shipped with v0.9.0, see above)

### What changed

- **Tools merged 23 → 12**: 20 extension tools collapse into 5 polymorphic tools by domain (`browser` / `shell` /
  `fleet` / `orchestrator` / `memory`, dispatching on `action`), while the core four `read`/`bash`/`edit`/`write` keep
  their schemas (710 tok). Old tool names are still callable from inside tools; UI / approval / i18n keep the old names.
- **Cache warming and first-round preheating**: CacheWarming is finally wired to a setting (desktop default `idle`) and
  the settings page shows the mode actually in effect; restoring a session pre-sends the prefix once with
  `maxTokens:1` (measured: preheating costs 16 tok).
- **Tool result deduplication**: repeated `read` of the same file and range, and repeated `bash` of the same command, are
  no longer replayed in full (identical output becomes a single sentence; if the output grew, only the tail diff is
  returned); errors and non-zero exits always return in full.
- **On-demand tool domains**: the medium-frequency `shell` domain is not declared by default; on first use
  `tool_search` activates it and it stays resident; `tool_search` returns only callable wire names and reorders active
  tools by canonical order (eliminating one extra prefix write at activation).
- **"On-demand tool domains" multi-select in settings**: writes `onDemandDomains` in `desktop-settings.json` and shows
  the list actually in effect with its source.

### Did default behavior change

| Item | v0.8.2 | v0.8.3 (default) |
| --- | --- | --- |
| Declared tools | 23 | **12** (`shell` activates on first use) |
| Static prefix | 8,146 tok | **6,244 tok** (core four stay 710) |
| Cache warming | UI showed a fake `off`, nothing actually took over | desktop default `idle`, settings page shows the real state |
| Tool results | duplicate content replayed in full | duplicates deduplicated, errors in full |
| Auto compaction | off | **still off** (no auto compaction) |

### How to use the switches

`PIFORGE_ON_DEMAND_DOMAINS` (environment variable) and the `onDemandDomains` setting:

| Value | Meaning |
| --- | --- |
| `0` | **everything resident** (use this to go back to "full schema every round") |
| `1` | **compatibility alias**: `memory` + `orchestrator` on demand (not "all on demand" — that was the historical semantics of steps 3–5) |
| `shell` / `browser,shell` | explicit list: the listed domains are on demand, the rest stay resident |
| unset | read the `onDemandDomains` setting; if that was never written either → default `shell` |

- **Priority: environment variable > `onDemandDomains` setting > default (`shell`)**. When the environment variable is
  present, the settings page's checkboxes are disabled and the source is shown.
- By default only `shell` is on demand; measurement shows `memory` / `orchestrator` are a net loss on demand, so they
  are **resident by default**; ticking them only shows a yellow notice, it is not forbidden.
- Setting changes **take effect for new sessions**; the current session must be reloaded.
- Existing users who previously used `=1`: behavior unchanged (it was always memory + orchestrator).
