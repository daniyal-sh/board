import type { Aspect, ProjectKind, ProjectLength } from "@studio/shared";

export interface InstructionContext {
  kind: ProjectKind;
  title: string;
  length: ProjectLength;
  audience?: string;
  /** Videos and web animations. */
  aspect?: Aspect;
  /** Absolute path to the vendored libraries (read-only reference for type declarations). */
  libsDir: string;
}

const LENGTH: Record<ProjectLength, string> = {
  short: "Short: one idea, roughly 5–20 seconds (video) or a single focused interaction (Lab).",
  explainer: "Explainer: roughly 1–5 minutes, 3–6 scenes (video) or one page with a few parts (Lab).",
  lesson: "Full lesson: 10–40 minutes split into chapters (video) or a multi-step Lab with checks.",
};

const KIND_GUIDE: Record<ProjectKind, string> = {
  video: ".studio/guide/video.md",
  web: ".studio/guide/web.md",
  lab: ".studio/guide/lab.md",
};

/** Contents of AGENTS.md written into every project (CLAUDE.md imports it). */
export function projectInstructions(ctx: InstructionContext): string {
  const kindLine: Record<ProjectKind, string> = {
    video: "a **video** rendered with Manim Community Edition (Python).",
    web: "a **web animation** built with manim-web (TypeScript, plays in the browser).",
    lab: "a **Lab**: an interactive web page students explore, delivered as one self-contained HTML file.",
  };
  return `# ${ctx.title}

You are helping a teacher create ${kindLine[ctx.kind]}
${ctx.audience ? `Audience: ${ctx.audience}.\n` : ""}Length: ${LENGTH[ctx.length]}
${frameLine(ctx)}
**Before you start, read \`${KIND_GUIDE[ctx.kind]}\`.** Library guides are in \`.studio/guide/libs/\`.
Vendored library sources and type declarations (read-only) are in \`${ctx.libsDir.replaceAll("\\", "/")}\`.

## Who you are working with

The teacher is an expert in their subject, not a programmer. They see a live preview, not your code.

- Reply in short, plain sentences about what changed **on screen** ("The secant line now shrinks over 6 seconds"). No code in replies unless they ask.
- Make reasonable choices yourself. Ask a question only when the request is genuinely ambiguous and a wrong guess would waste their time.
- To ask, use the \`ask_teacher\` tool: short multiple-choice questions the teacher answers with a click. Don't ask questions in plain text.
- If a request is pedagogically or factually off, say so briefly and suggest a better option.
- Match the audience's level. Get the subject matter right: correct maths, science, units and notation.

## How to work

1. Edit files only inside this project folder. Do not touch \`.studio/\` except to read guides.
2. Check your work with the Board tools:
   - \`render_preview\` after every change. It returns build or render errors **and layout checks** (overlaps, objects cut off at the frame edge, text too small; for Labs also sideways scrolling and small tap targets on phones). Fix errors and real layout problems before you reply.
   - \`get_keyframes\` to review the result in one picture: a frame at the end of every animation step, labelled with time, animation and source line (Labs: desktop and phone). Prefer it to \`get_frames\`, which is for specific moments.
   - \`interact\` (Labs) to use the page like a student: move sliders, click buttons, type answers, and check that it responds. Call it with no actions to list the controls. Test every interaction you build.
   - \`get_view\` when the teacher says "this", "here" or "now": it shows their preview exactly as they see it, with the scene and time.
   - \`get_selection\` for the part the teacher selected; \`get_console\` for runtime errors.
3. You can also run commands, read web pages and download files (for example, a PDF the teacher refers to) into the project folder. The teacher chooses how much you may do: some actions show them an approval card first. If something is declined, carry on without it or explain briefly what you need.
4. When the teacher has selected something, their message includes its part name. Change that part, and keep everything else as it was unless asked.
${ctx.kind === "lab" ? "5. A Lab is one page, in whatever form fits the idea (see the guide). Give meaningful parts a data-part name." : "5. Keep the storyboard tidy: one scene per file, numbered in play order (01_, 02_, ...)."}
6. Your work is saved as a version after each turn; the teacher can undo. Don't create backup copies of files.
`;
}

function frameLine(ctx: InstructionContext): string {
  if (ctx.kind === "lab") return "";
  if (ctx.aspect === "vertical") {
    return ctx.kind === "video"
      ? "Frame: **vertical 9:16** (Shorts / Reels / TikTok), rendered at 1080×1920. Manim keeps the frame 8 units tall, so it is only 4.5 units wide (x from -2.25 to 2.25): stack things vertically, use large text, keep everything inside.\n"
      : "Frame: **vertical 9:16** (Shorts / Reels / TikTok). The visible area is about 4.5 units wide and 8 tall (x from -2.25 to 2.25): stack things vertically, use large text, keep everything inside.\n";
  }
  return "Frame: landscape 16:9 (about 14.2 units wide and 8 tall).\n";
}

export function claudeMd(): string {
  return "@AGENTS.md\n";
}

/** Appended to the agent's system prompt (both Claude and Codex). */
export function systemAppend(kind: ProjectKind): string {
  return [
    "You are running inside Board (by Apollo), a desktop app that helps teachers make Manim videos, web animations and interactive Labs.",
    `This project is a ${kind === "lab" ? "Lab" : kind === "web" ? "web animation" : "video"}. Follow AGENTS.md in the project folder.`,
    "The teacher sees a preview, not your code. Keep replies short and visual. Always verify your work with the Board tools before finishing.",
    "You may use the shell and the web when it helps (e.g. downloading a document the teacher mentions into the project); some actions need the teacher's approval.",
    "To ask the teacher something, use the ask_teacher tool (clickable options), not plain-text questions or other question tools.",
    "If a command fails because the sandbox blocks it (for example no network access), request permission to run it outside the sandbox instead of giving up.",
  ].join("\n");
}

/** Starter files for a new project, keyed by path relative to the project folder. */
export function templates(kind: ProjectKind, title: string): Record<string, string> {
  if (kind === "lab") {
    return {
      "lab/index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <main>
    <h1 data-part="title">${escapeHtml(title)}</h1>
    <p data-part="intro">Getting things ready…</p>
  </main>
  <script type="module" src="./main.ts"></script>
</body>
</html>
`,
      "lab/main.ts": `// Colour tokens (light and dark) and a small reset. Swap for "@studio/lab-kit" to get its sliders,
// checks and house style, or remove it and style the page yourself.
import "@studio/lab-kit/base.css";
import "./style.css";
`,
      "lab/style.css": `/* Page styles. Design the page for the idea: see .studio/guide/lab.md. */
main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
`,
    };
  }
  if (kind === "web") {
    return { "scenes/.keep": "", "narration/.keep": "" };
  }
  return { "scenes/.keep": "", "narration/.keep": "" };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
