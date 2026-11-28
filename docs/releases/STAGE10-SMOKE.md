# Stage 10 packaged smoke checklist

**English** · [简体中文](./STAGE10-SMOKE.zh-CN.md)

> Environment: Windows x64 · `release/win-unpacked` · Node 24 · Electron 43.7.7  
> Baseline: `dev/v0.6.0` @ `1358d86`, dev tests 877 pass / 0 fail / 3 skipped  
> Log directory: `release/logs/`

## Results overview

| # | Check | Command | Result | Log |
|---|---|---|---|---|
| 0 | Packaged artifacts can be produced | `npm run pack` | PASS | console |
| 1 | Host → Next SSE lifecycle proxy | `node scripts/smoke-packaged-events.mjs` | PASS | `release/logs/stage10-events.log` |
| 2 | Main BrowserManager + named pipe bridge | `node scripts/smoke-packaged-browser.mjs` | PASS | `release/logs/stage10-browser.log` |
| 3 | Fleet refresh after window minimize/restore | `node scripts/smoke-packaged-fleet-ui.mjs` | PASS | `release/logs/stage10-fleet-ui.log` |
| 4 | Fleet panel read-only rendering | same as above | PASS | same as above |

## 1. Host → Next proxy chain

- The packaged Host and packaged Next standalone are started for real.
- A throwaway extension calls `spawnSubagent()` with a faux provider, producing a real lifecycle.
- `/api/subagents/events` is established first, then `agent.create` is triggered.
- It asserts that `subagent_started`, `subagent_output` and `subagent_finished` are received.
- Final log:

```text
packaged-events smoke: OK (subagent_finished -> subagent_started -> subagent_output -> subagent_finished)
```

Note: the host's 100ms broadcast coalesces state, and `subagents.changed` now also carries an ordered increment in `events[]`; the smoke verifies the three events from `events[]`. The `subagent_finished` that appears at both ends is "most recent event + increment array" showing up together, not a duplicate dispatch.

## 2. Main BrowserManager / BrowserHostBridge

- The real `release/win-unpacked/PiForge.exe`, with `SMOKE_BROWSER=1` loading the smoke entry dynamically; the normal startup path does not load it.
- A `BrowserWindow` + `WebContentsView` is created and the production `BrowserManager` is called.
- A fake Host issues `open` / `read` / `screenshot` in sequence over the named pipe.
- Assertions: the read text contains the fixture, the PNG is non-empty, `ready=true`, `boundsGeneration>0`, and the snapshot carries `windowId/ownerId`.

```text
SMOKE_BROWSER_OK {... "screenshot":{"ok":true,...,"bytes":31392,"ready":true,"boundsGeneration":1}}
packaged-browser smoke: OK (open/read/screenshot, 31392 base64 chars)
```

Boundary: Electron throws `UnknownVizError` when `capturePage()` is called on a `WebContentsView` that was never shown. The smoke window therefore uses `opacity: 0 + showInactive()` (invisible but composited) rather than a plain `show:false`. This does not affect the production BrowserPanel's display path.

## 3. Fleet panel refresh and read-only

```text
SMOKE_FLEET_OK {"method":"minimize","minimized":true,"beforeTs":1792508778905,"afterTs":1792508785010,"readOnly":true}
packaged-fleet-ui smoke: OK
```

- A real `minimize()` followed by `restore()` 5 seconds later.
- After restoring, `data-last-loaded-at` increases (about a 6-second span, including an active refresh).
- The DOM contains no textarea / text input / send button, and `readOnly=true`.
- The `Scheduling Agent Host restart` at the end of the log is the normal restart scheduling triggered by the Host exiting when the smoke calls `app.exit()` itself; it is not a smoke failure.

## 4. Automated tests

```text
npx tsc --noEmit        PASS
npm run lint            PASS (0 error, 3 pre-existing warnings)
npm run build:agent-host PASS
npm run build:electron  PASS
npm test                PASS (885 pass / 0 fail / 3 skipped)
```

## Uncovered boundaries (recorded honestly)

- The Herdr fleet is an in-memory AgentSession inside the Host, not an OS child process; it reuses only the managed state enum / transitions and does not enter the PID / taskkill / readiness cleanup path.
- The packaged-events extension calls `spawnSubagent()` directly rather than going through real model tool selection; what is verified is the event / proxy chain, not model behavior.
- The packaged-browser smoke uses a fake Host named pipe and only verifies the Main-side bridge protocol and WebContentsView; it does not connect to the real Host's agent tool call chain (that chain is covered by host unit tests).
- Multi-window sharing or an independent browser page per sub-agent is not implemented; `windowId` / `ownerId` are only reserved for pass-through.
- The fleet panel smoke runs with an empty fleet, so it only verifies the read-only layout and refresh; no visual screenshot comparison with agent cards present was done.
