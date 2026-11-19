# Architecture

**Apollo Board**, an open-source app by the Apollo team. The product name is one constant, `BRAND` in `packages/shared/src/brand.ts`.

A desktop app for teachers that makes three kinds of things with an AI agent the teacher already pays for (Claude Code or Codex). Everything runs and stays on the teacher's computer: there is no account, no server and no upload. The only network traffic is the assistant CLI talking to its own service (and, when the teacher allows it, commands or downloads the assistant runs).

| Kind | Engine | Output |
|---|---|---|
| **Video** | Manim Community (Python, local) | MP4 + SRT, GIF; 16:9 or 9:16 |
| **Web animation** | manim-web (TypeScript, in the browser) | Single HTML file, GIF; 16:9 or 9:16 |
| **Lab** | Any of the bundled web libraries | Single self-contained HTML file |

## Repository layout

```
apps/
  desktop/        Electron app (electron-vite + React + Tailwind v4)
    src/main/       main process: projects, agents, renderers, builds, exports
    src/preload/    typed IPC bridge (window.studio)
    src/renderer/   React UI (Apollo Study Space look, light and dark)
    build/          icons and brand assets
packages/
  shared/         types shared by main and renderer (project schema, IPC contracts, brand)
  lab-kit/        CSS + small helpers every Lab can use (sliders, steps, checks, math)
  agent-kit/      system prompts, per-kind guidance and library cheat sheets given to the agent
python/
  studio_manim/   Manim CE plugin: render timeline, object boxes, narration sync, concat, GIF
```

## Projects on disk

```
~/Documents/Apollo Board/<project-slug>/
  project.json        { id, kind, title, aspect, scenes[], agent, voice }
  .git/               history and undo (teachers never see git)
  AGENTS.md / CLAUDE.md   generated guidance for the agent, per kind
  scenes/01_hook.py | .ts   one scene per file (videos and web animations)
  lab/index.html, lab/main.ts, lab/style.css   (Labs)
  narration/<scene>.md      narration scripts with {{mark:name}} cues
  build/              renders, previews, thumbnails, narration audio (git-ignored)
```

Every agent turn ends with a commit, which drives Versions and Undo.

## Agents

`src/main/agents/` has one driver interface with two implementations:

- **Claude**: `@anthropic-ai/claude-agent-sdk` `query()` with `pathToClaudeCodeExecutable` pointed at the user's installed `claude`, so it runs on the user's own login.
- **Codex**: `codex app-server` over JSON-RPC (stdio), spawned natively.

The teacher picks the access level next to the model picker: Ask first (approval cards), Auto (commands and web inside the project folder) or Full access.

Apollo Board tools (a local MCP server, 127.0.0.1 with a random token, scoped to the open project):

| Tool | What it does |
|---|---|
| `render_preview` | Video: low-quality render of one scene. Web/Lab: rebuild and reload the preview. Returns errors. |
| `get_frames` | Screenshots of the preview at given times (video, web) or desktop/phone sizes (Lab). |
| `get_selection` | What the teacher clicked: part name, scene, time, source line. |
| `get_console` | Console errors and warnings from the Lab or web animation preview. |
| `ask_teacher` | Multiple-choice questions shown as a card in the chat; waits for the answers. |

## Builds

- **Lab / web animation**: esbuild bundles against vendored libraries (no network), then inlines JS, CSS and fonts into one HTML file. The preview runs in a sandboxed iframe on a custom protocol. Web animations are recorded into one manim-web Player timeline, which the app drives (play, scrub, jump scenes) and which syncs narration.
- **Video**: Manim per scene with the `studio_manim` plugin, which writes a timeline (plays, marks, object boxes, source lines). Drafts are joined for the whole-video preview; the export renders in high quality, joins without re-encoding and writes SRT.
- **GIF**: videos via PyAV + Pillow (one shared palette); web animations by stepping the recorded timeline in a hidden window and encoding with gifenc.

## Voice

- AI voice: Kokoro (local). Recordings: aligned with Whisper (local). Whole sentences are synthesised and aligned back to the script.
- `{{mark:name}}` cues in scripts map to `wait_until("name")` (Manim) or `waitUntil("name")` (manim-web).
