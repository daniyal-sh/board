# Studio

**An open-source desktop app for teachers to make maths and science visible**, using the AI subscription they already have.

Describe an idea, and Claude Code or Codex builds it for you as one of three things:

| | Made with | You get |
|---|---|---|
| **Video** | [Manim Community](https://github.com/ManimCommunity/manim), rendered on your computer | MP4 + captions |
| **Web animation** | [manim-web](https://github.com/maloyan/manim-web), plays in any browser | One HTML file, or a share link |
| **Lab** | An interactive page (sliders, simulations, checks) | One HTML file, or a share link |

Then keep shaping it: click anything in the preview and say what should change, add narration with a free local AI voice or your own recording, and roll back to any earlier version.

> "Studio" is a working name. The product name lives in one place: `packages/shared/src/brand.ts`.

## Highlights

- **Uses your own Claude Code or Codex sign-in.** No API keys, no extra subscription. Studio drives the CLI you already have installed.
- **No account needed.** Everything works offline on your computer. Signing in with Google is only needed to publish share links.
- **Click to edit.** Select a part of a Lab, a web animation, or an object in a rendered Manim video, and the assistant gets its name, scene, time and source line.
- **The assistant checks its own work.** It renders a preview, reads console errors and looks at screenshots (desktop and phone) before it says it's done.
- **Narration that drives the timing.** Put `{{mark:name}}` before a word; animations wait for that word. AI voice (Kokoro, local and free) or your own recording (aligned with Whisper, local).
- **One-file sharing.** Labs and web animations export as a single self-contained HTML file with every library inlined. It works offline and can be uploaded to any LMS.
- **Versions.** Every change is saved. Undo, or restore any earlier version. (It's git under the hood; you never see it.)

## Repository

```
apps/desktop      Electron app (electron-vite, React, Tailwind)
apps/cloud        Publishing backend: Cloudflare Worker (Hono), D1, R2, Google sign-in
packages/shared   Types shared by the app and the cloud
packages/lab-kit  Styles, web components and vendored libraries for Labs
packages/agent-kit  Instructions and library guides given to the assistant
python/studio_manim  Manim plugin: render timeline, click-to-edit data, narration sync
docs/ARCHITECTURE.md  How it fits together
```

## Develop

Requirements: Node 22+, pnpm, and Claude Code (`claude`) or Codex (`codex`) installed and signed in.

```sh
pnpm install
pnpm dev            # desktop app with hot reload
```

Videos need Python, Manim and LaTeX. The app installs them into its own folder the first time you make a video (Settings → Rendering), so you don't have to.

### Self-tests

The main process has a self-test mode that exercises the real pipeline without clicking through the UI:

```sh
cd apps/desktop && pnpm build
STUDIO_SELFTEST=./selftest-out STUDIO_SELFTEST_MODE=build npx electron .   # build sample Lab + web animation, screenshots
STUDIO_SELFTEST_MODE=agent STUDIO_SELFTEST_AGENT=claude ...                # a real assistant turn (claude | codex)
STUDIO_SELFTEST_MODE=voice ...                                             # AI narration + speech alignment
STUDIO_SELFTEST_MODE=video ...                                             # Manim setup, render, timeline, narration
STUDIO_SELFTEST_MODE=ui ...                                                # screenshots of the real UI
```

Use `STUDIO_PROJECTS_DIR` and `STUDIO_DATA_DIR` to keep test projects and downloads out of your real folders.

### Cloud (publishing)

```sh
cd apps/cloud
cp .dev.vars.example .dev.vars          # add GOOGLE_CLIENT_SECRET and SESSION_SECRET
pnpm db:migrate:local
pnpm dev                                # http://127.0.0.1:8787
```

Set `GOOGLE_CLIENT_ID` in `wrangler.jsonc` and add `http://127.0.0.1:8787/auth/google/callback` as an authorised redirect URI in Google Cloud Console. Run the desktop app with `STUDIO_CLOUD_URL=http://127.0.0.1:8787`.

In production, serve the app and the published content from **two different registrable domains** (`APP_ORIGIN` and `SANDBOX_ORIGIN`). Published pages run untrusted JavaScript; they are also served with a CSP `sandbox` directive and no network access.

### Release

Push a tag like `v0.1.0`. GitHub Actions builds installers for Windows, macOS and Linux and publishes them to GitHub Releases, which the app uses for auto-updates.

## License

MIT
