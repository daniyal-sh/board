import type { ProjectKind, ProjectLength } from "@studio/shared";

export interface InstructionContext {
  kind: ProjectKind;
  title: string;
  length: ProjectLength;
  audience?: string;
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

**Before you start, read \`${KIND_GUIDE[ctx.kind]}\`.** Library guides are in \`.studio/guide/libs/\`.
Vendored library sources and type declarations (read-only) are in \`${ctx.libsDir.replaceAll("\\", "/")}\`.

## Who you are working with

The teacher is an expert in their subject, not a programmer. They see a live preview, not your code.

- Reply in short, plain sentences about what changed **on screen** ("The secant line now shrinks over 6 seconds"). No code in replies unless they ask.
- Make reasonable choices yourself. Ask a question only when the request is genuinely ambiguous and a wrong guess would waste their time.
- If a request is pedagogically or factually off, say so briefly and suggest a better option.
- Match the audience's level. Get the subject matter right: correct maths, science, units and notation.

## How to work

1. Edit files only inside this project folder. Do not touch \`.studio/\` except to read guides.
2. Check your work with the Studio tools:
   - \`render_preview\` after every change; it returns build or render errors. Fix them before you reply.
   - \`get_console\` for runtime errors and warnings in web previews.
   - \`get_frames\` to look at the result (layouts, overlaps, cut-off text, pacing). Check before you say it is done.
   - \`get_selection\` when the teacher refers to "this" or "the selected" thing.
3. You can also run commands, read web pages and download files (for example, a PDF the teacher refers to) into the project folder. The teacher chooses how much you may do: some actions show them an approval card first. If something is declined, carry on without it or explain briefly what you need.
4. When the teacher has selected something, their message includes its part name. Change that part, and keep everything else as it was unless asked.
${ctx.kind === "lab" ? "5. A Lab is one page. Give meaningful parts a data-part name; there's no need to split it into sections." : "5. Keep the storyboard tidy: one scene per file, numbered in play order (01_, 02_, ...)."}
6. Your work is saved as a version after each turn; the teacher can undo. Don't create backup copies of files.
`;
}

export function claudeMd(): string {
  return "@AGENTS.md\n";
}

/** Appended to the agent's system prompt (both Claude and Codex). */
export function systemAppend(kind: ProjectKind): string {
  return [
    "You are running inside Studio, a desktop app that helps teachers make Manim videos, web animations and interactive Labs.",
    `This project is a ${kind === "lab" ? "Lab" : kind === "web" ? "web animation" : "video"}. Follow AGENTS.md in the project folder.`,
    "The teacher sees a preview, not your code. Keep replies short and visual. Always verify your work with the Studio tools before finishing.",
    "You may use the shell and the web when it helps (e.g. downloading a document the teacher mentions into the project); some actions need the teacher's approval.",
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
  <main class="lab">
    <h1 data-part="title">${escapeHtml(title)}</h1>
    <p class="lead" data-part="intro">Getting things ready…</p>
  </main>
  <script type="module" src="./main.ts"></script>
</body>
</html>
`,
      "lab/main.ts": `import "@studio/lab-kit";
import "./style.css";
`,
      "lab/style.css": `/* Page-specific styles. The lab kit already provides the base look. */
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
