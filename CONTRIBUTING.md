# Contributing to PiForge

**English** · [简体中文](./CONTRIBUTING.zh-CN.md)

Thanks for wanting to work on PiForge. We prefer **small, focused, verifiable** changes: solve one user-visible problem at a time, no unrelated refactors, no heavyweight dependencies.

> Read [`AGENTS.md`](./AGENTS.md) before you submit. Its "architecture laws" and "UI laws" are hard constraints, not suggestions.

## Filing an issue

- Search existing issues / PRs first to avoid duplicates.
- For bugs, include: PiForge version or commit, OS version, reproduction steps, expected vs. actual behavior.
- For feature requests, state: what problem it solves, the scope, and what you explicitly are not doing.
- Never paste API keys, `auth.json`, full session `.jsonl`, or unredacted logs.

## Sending a pull request

1. Branch from the latest `main`; prefer `fix/…`, `feat/…`, `docs/…` or `chore/…`.
2. Keep it focused: one PR does one thing; no drive-by refactors of unrelated modules.
3. The PR description should contain at least:
   - **Why**: why this change is needed
   - **Scope**: which files / behaviors changed
   - **Out of scope**: what you deliberately did not do
   - **Verification**: which commands you ran, and how to verify manually
4. Pass these locally before submitting:

```bash
npx tsc --noEmit
npm run lint
npm test
```

5. UI changes must come with a screenshot or short recording, and a note on how they behave in the light theme, in a narrow window, and with the right panel expanded / collapsed.

## Architecture laws

- **Reuse the official SDK directly**: use `@earendil-works/pi-coding-agent`; do not add proxies, extra network layers or a home-grown agent service in the Electron / Next layers.
- **No external servers**: sessions, files, Git, processes and configuration all stay local; do not add cloud dependencies for lightweight features.
- **Do not break the SSE stream**: streaming messages, tool events, extension UI and session state keep using `/api/agent/[id]/events`.
- **Performance first**: incremental loading of historical sessions, lazy rendering of long tool output, batched tool calls; never do a full disk scan on the main thread.
- **Local first**: never send user sessions, keys or project files to PiForge's own services.

## UI laws

- **The three-column layout is fixed**: sessions on the left, chat in the middle, file workspace on the right.
- **Left column is a fixed 260px**: light gray-white background, single-line truncation; no embedded file tree, no duplicated buttons.
- **Right column is adaptive and resizable**: about 560px by default, draggable from 280 to 800px; the file tree is always present and must not be covered by a full-screen tab.
- **Light frost-blue on off-white**: main area `#FCFCFA`, cards and inputs pure white with soft shadows; do not introduce a dark theme or high-saturation blocks.
- **File previews are floating windows**: files open in a floating window inside the right panel and never change the chat area.
- **Less is more**: reuse existing components and style tokens; do not add duplicate buttons, menus or overlays.

## Dependencies and code style

- No heavyweight dependencies (no PDF / Excel / Monaco suites); prefer the existing `react-markdown`, `react-syntax-highlighter`, `lucide-react` and the official SDK.
- All user-visible strings go into `lib/i18n/dictionaries.ts` (Chinese and English); never hardcode them in components.
- Separate business logic from UI: testable parsing, routing, path handling and state computation belong in `lib/` or pure-function modules, with unit tests.
- Do not delete core modules that merely look unused — confirm references and runtime paths first.

## Commit messages

Use clear Conventional Commits style:

```text
feat(right-panel): floating file preview
fix(composer): keep draft when switching sessions
docs: refresh README for v0.1.0
```

## License

By contributing you agree to release your code under the project's **MIT License**. See [`LICENSE`](./LICENSE).
