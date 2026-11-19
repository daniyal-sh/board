# Architecture

Working name: **Studio** (the product name is one constant, `BRAND` in `packages/shared/src/brand.ts`).

A desktop app for teachers that makes three kinds of things with an AI agent the teacher already pays for (Claude Code or Codex):

| Kind | Engine | Output | Shareable link |
|---|---|---|---|
| **Video** | Manim Community (Python, local) | MP4 + SRT | Upload MP4 (later) |
| **Web animation** | manim-web (TypeScript, in the browser) | Single HTML file, MP4 via WebCodecs | Yes |
| **Lab** | Any of the bundled web libraries | Single self-contained HTML file | Yes |

## Repository layout

```
apps/
  desktop/        Electron app (electron-vite + React + Tailwind v4)
    src/main/       main process: projects, agents, renderers, builds, publishing
    src/preload/    typed IPC bridge (window.studio)
    src/renderer/   React UI
  cloud/          Cloudflare Worker (Hono): API, share pages, sandboxed user content
packages/
  shared/         types shared by desktop + cloud (project schema, IPC contracts, brand)
  lab-kit/        CSS + small helpers every Lab can use (sliders, steps, checks, math)
  agent-kit/      system prompts, per-kind guidance and library cheat sheets given to the agent
python/
  studio_manim/   Manim CE plugin: render instrumentation (object boxes, play timings), voiceover service
```

## Projects on disk

```
~/Documents/Studio/<project-slug>/
  project.json        { id, kind, title, createdAt, scenes[], voice, publish }
  .git/               history and undo (isomorphic-git; teachers never see git)
  AGENTS.md / CLAUDE.md   generated guidance for the agent, per kind
  # video
  scenes/01_hook.py ...    one Manim Scene per file
  # web animation
  scenes/01_hook.ts ...
  # lab
  lab/index.html, lab/main.ts, lab/style.css, lab/assets/
  audio/              narration takes (wav) + alignment json
  build/              renders, single-file HTML, previews (git-ignored)
```

Every agent turn ends with a commit (`Turn: <prompt summary>`), which drives History, Undo and "Try variations" (branches).

## Agents

`src/main/agents/` exposes one interface, `AgentSession`, with two drivers:

- **Claude**: `@anthropic-ai/claude-agent-sdk` `query()` with `pathToClaudeCodeExecutable` pointed at the user's installed `claude`, so it runs on the user's own login (same approach as t3code). Studio tools are provided in-process with `createSdkMcpServer`.
- **Codex**: `codex app-server` over JSON-RPC (stdio). Studio tools are provided through a local MCP server.

Studio tools (MCP), scoped to the open project:

| Tool | What it does |
|---|---|
| `render_preview` | Video: low-quality render of one scene. Web/Lab: rebuild and reload the preview. Returns errors. |
| `get_frames` | Screenshots of the preview at given times (video) or desktop/phone sizes (Lab). The agent checks its own work. |
| `get_selection` | What the teacher clicked: object name, source location, time. |
| `get_console` | Console errors and warnings from the Lab or web animation preview. |
| `set_narration` | Write the narration script for a scene, with sync markers. |

The agent edits files with its own built-in file tools, restricted to the project folder.

## Builds

- **Lab / web animation**: esbuild bundles `main.ts` against vendored libraries (no network), then inlines JS, CSS and fonts into one HTML file. Preview runs in a sandboxed `<webview>` with no Node access. A picker script (preview only) powers click-to-edit using `data-part` attributes.
- **Video**: `uv run manim -ql` per scene with the `studio_manim` plugin, which writes `scene.timeline.json` (play calls, durations, source lines, object boxes per frame). That file drives the timeline and click-to-edit. The final export renders at 1080p, mixes audio with ffmpeg and writes SRT.

## Voice

- AI voice: Kokoro (local, free). Word timings from Kokoro where available, otherwise forced alignment.
- My voice: MediaRecorder, then whisper.cpp for word timings.
- Sync markers in scripts (`{{mark:secant}}`) map to `wait_until_bookmark` calls in scenes.

## Cloud (Cloudflare)

- `api.<domain>`: Hono on Workers. Google sign-in, publish, list, delete, set visibility. D1 for metadata, R2 for files.
- `<domain>/l/<id>`: share page (title, author, iframe to the sandbox).
- `<id>.<sandbox-domain>`: serves the published HTML from R2 on a separate registrable domain, with a strict CSP, so a Lab's JavaScript can never touch the main site's cookies.
- Visibility: private (owner only, signed URL), unlisted (link), public (gallery).

## Build order

1. Monorepo, shared types, desktop shell (window, home, project view, design system).
2. Project store (folders + git), agent layer (Claude, then Codex), chat UI with streamed steps.
3. Labs: lab-kit, vendored libs, bundler, preview, picker, self-test, single-file export.
4. Cloud: worker, Google sign-in, publish flow, share and sandbox pages.
5. Web animations (manim-web), including WebCodecs MP4 export.
6. Videos: uv bootstrap, Manim CE render, plugin, timeline, click-to-edit.
7. Voice: Kokoro, recording, whisper.cpp alignment, captions.
8. Packaging, auto-update, docs.
