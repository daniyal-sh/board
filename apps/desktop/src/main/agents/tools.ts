import http from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Selection } from "@studio/shared";
import { buildPreview, consoleFor, inspectPreview, labSession, webSteps, type LabAction, type ViewportName } from "../build/preview";
import { analyseLayout, formatFindings, snapshotsFromTimeline } from "../inspect/layout";
import { contactSheet, spread } from "../inspect/sheet";
import { mainWindow } from "../window";
import { projects } from "../projects";
import { video } from "../video/renderer";

/** Live state the tools can read for a project. */
interface ToolContext {
  selection?: Selection;
  /** Shows the questions in the chat and waits for the teacher's answers (null: skipped). */
  ask?: (req: { intro?: string; questions: { question: string; options: string[]; multi?: boolean }[] }) => Promise<string[] | null>;
  onPreviewUpdated: () => void;
  onStep: (label: string, detail?: string) => void;
}

const contexts = new Map<string, ToolContext>();

export function setToolContext(projectId: string, ctx: ToolContext): void {
  contexts.set(projectId, ctx);
}

export function setSelection(projectId: string, selection: Selection | undefined): void {
  const ctx = contexts.get(projectId);
  if (ctx) ctx.selection = selection;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string): { content: Content[] } => ({ content: [{ type: "text", text: t }] });
const image = (png: Buffer): Content => ({ type: "image", data: png.toString("base64"), mimeType: "image/png" });

function formatConsole(lines: { level: string; text: string }[]): string {
  const important = lines.filter((l) => l.level === "error" || l.level === "warn");
  if (!important.length) return "Console: no errors or warnings.";
  return `Console (${important.length}):\n` + important.map((l) => `[${l.level}] ${l.text}`).join("\n");
}

function createServer(projectId: string): McpServer {
  const server = new McpServer({ name: "studio", version: "0.1.0" });
  const ctx = () => contexts.get(projectId);

  server.registerTool(
    "render_preview",
    {
      title: "Render preview",
      description:
        "Rebuild the preview the teacher sees. Lab / web animation: bundles the page and loads it, returning build errors and console errors. Video: renders the given scene at low quality and returns Python errors. Call after every change.",
      inputSchema: { scene: z.string().optional().describe("Scene id (file name without extension). Videos: defaults to the selected or most recently changed scene.") },
    },
    async ({ scene }) => {
      const m = projects.manifest(projectId);
      const frameHeightPx = m.aspect === "vertical" ? 1920 : 1080;
      if (m.kind === "video") {
        const r = await video.renderPreview(projectId, scene);
        ctx()?.onPreviewUpdated();
        if (!r.ok) return text(`Render failed for ${r.scene}:\n${r.log}`);
        const tl = video.timeline(projectId, r.scene);
        const checks = tl ? formatFindings(analyseLayout(snapshotsFromTimeline(tl), { frameHeightPx }), `${r.scene}, end of each step`) : "";
        return text(`Rendered ${r.scene} (${r.durationSec?.toFixed(1)} s) in ${r.seconds.toFixed(1)} s.\n${r.log}\n${checks}`.trim());
      }
      const res = await buildPreview(projectId);
      if (!res.ok) return text(`Build failed:\n${res.errors.join("\n")}`);
      ctx()?.onPreviewUpdated();
      const kb = Math.round((res.sizeBytes ?? 0) / 1024);
      const head = `Build OK: ${kb} KB, libraries: ${res.libraries?.join(", ") || "none"}.`;
      if (m.kind === "web") {
        const steps = await webSteps(projectId, { scene, pictures: false, max: 24 });
        const findings = analyseLayout(
          steps.frames.map((f) => ({ t: f.t, scene: scene ? undefined : f.scene, items: f.layout })),
          { frameHeightPx },
        );
        return text([head, `${steps.frames.length} animation steps, ${steps.duration.toFixed(1)} s.`, formatFindings(findings, "end of each step"), formatConsole(steps.console)].join("\n"));
      }
      const [d, ph] = [await labSession(projectId, { viewport: "desktop" }), await labSession(projectId, { viewport: "phone" })];
      const findings = [...d.findings.map((f) => `desktop: ${f}`), ...ph.findings.map((f) => `phone: ${f}`)];
      return text([head, formatFindings(findings, "desktop and phone"), formatConsole([...d.console, ...ph.console])].join("\n"));
    },
  );

  server.registerTool(
    "get_console",
    {
      title: "Get console",
      description: "Console errors and warnings from the latest preview load (Labs and web animations).",
      inputSchema: {},
    },
    async () => text(formatConsole(consoleFor(projectId))),
  );

  server.registerTool(
    "get_frames",
    {
      title: "Get frames",
      description:
        "Screenshots of the current preview so you can check your work. Labs: desktop and/or phone layouts. Web animations: frames at given seconds. Videos: frames of a rendered scene at given seconds.",
      inputSchema: {
        viewports: z.array(z.enum(["desktop", "phone"])).optional().describe("Labs: which layouts to capture (default both)."),
        times: z.array(z.number().min(0).max(120)).max(6).optional().describe("Seconds into the animation / scene."),
        scene: z.string().optional().describe("Scene id for videos and web animations."),
      },
    },
    async ({ viewports, times, scene }) => {
      const m = projects.manifest(projectId);
      const content: Content[] = [];
      if (m.kind === "video") {
        const frames = await video.frames(projectId, scene, times ?? [1, 4, 8]);
        if (!frames.length) return text("No rendered video for that scene yet. Call render_preview first.");
        for (const f of frames) {
          content.push({ type: "text", text: `${f.scene} at ${f.time.toFixed(1)} s` });
          content.push({ type: "image", data: f.png.toString("base64"), mimeType: "image/png" });
        }
        return { content };
      }
      if (m.kind === "lab") {
        for (const vp of (viewports?.length ? viewports : ["desktop", "phone"]) as ViewportName[]) {
          const r = await inspectPreview(projectId, { viewport: vp, times: times?.length ? times : [1.5] });
          for (const f of r.frames) {
            content.push({ type: "text", text: `${vp} at ${f.time} s` });
            content.push({ type: "image", data: f.png.toString("base64"), mimeType: "image/png" });
          }
        }
      } else {
        const query = scene ? `scene=${encodeURIComponent(scene)}&only=1` : "";
        const r = await inspectPreview(projectId, { times: times?.length ? times : [1, 3, 6], query });
        for (const f of r.frames) {
          content.push({ type: "text", text: `${scene ?? "animation"} at ${f.time} s` });
          content.push({ type: "image", data: f.png.toString("base64"), mimeType: "image/png" });
        }
      }
      return { content };
    },
  );

  server.registerTool(
    "get_selection",
    {
      title: "Get selection",
      description: "What the teacher has selected in the preview: part name, scene, time and source location when known.",
      inputSchema: {},
    },
    async () => {
      const s = ctx()?.selection;
      return text(s ? JSON.stringify(s, null, 2) : "Nothing is selected.");
    },
  );

  // ------------------------------------------------------------------ keyframes

  server.registerTool(
    "get_keyframes",
    {
      title: "Get keyframes",
      description:
        "One labelled picture of the animation: a frame at the end of every animation step (up to 12), each tagged with its time, the animation and (videos) the source line, plus layout checks. Cheaper and more complete than get_frames for reviewing a scene or the whole video. Labs: desktop and phone side by side.",
      inputSchema: {
        scene: z.string().optional().describe("Scene id (file name without extension). Omit for the whole video / animation."),
      },
    },
    async ({ scene }) => {
      const m = projects.manifest(projectId);
      const vertical = m.aspect === "vertical";
      const frameHeightPx = vertical ? 1920 : 1080;
      if (m.kind === "lab") {
        const [d, p] = [await labSession(projectId, { viewport: "desktop" }), await labSession(projectId, { viewport: "phone" })];
        const sheet = await contactSheet(
          [
            { png: d.png, label: "Desktop (1280 px)" },
            { png: p.png, label: "Phone (390 px)" },
          ],
          { cols: 2, cellWidth: 480, aspect: 1280 / 800 },
        );
        const findings = [...d.findings.map((f) => `desktop: ${f}`), ...p.findings.map((f) => `phone: ${f}`)];
        return { content: [image(sheet), { type: "text", text: [formatFindings(findings, "Lab"), formatConsole([...d.console, ...p.console])].join("\n") }] };
      }
      if (m.kind === "web") {
        const r = await webSteps(projectId, { scene });
        if (!r.frames.length) return text(`No frames: the animation didn't load.\n${formatConsole(r.console)}`);
        const sheet = await contactSheet(
          r.frames.map((f) => ({ png: f.png, label: `${f.t.toFixed(1)} s · ${scene ? "" : `${f.scene} · `}${f.label}` })),
          { aspect: vertical ? 9 / 16 : 16 / 9 },
        );
        const findings = analyseLayout(
          r.frames.map((f) => ({ t: f.t, scene: scene ? undefined : f.scene, items: f.layout })),
          { frameHeightPx },
        );
        return { content: [image(sheet), { type: "text", text: [`${r.frames.length} steps, ${r.duration.toFixed(1)} s in total.`, formatFindings(findings, "end of each step"), formatConsole(r.console)].join("\n") }] };
      }
      // Video: needs rendered drafts.
      const ids = scene ? [scene] : m.scenes.map((s) => s.id);
      const steps = ids.flatMap((id) => {
        const tl = video.timeline(projectId, id);
        return (tl?.plays ?? []).filter((p) => p.kind !== "wait" && p.end > p.start).map((p) => ({ id, t: Math.max(p.start + 0.01, p.end - 0.04), label: p.label, line: p.line }));
      });
      if (!steps.length) return text("Nothing rendered yet. Call render_preview for the scene first.");
      const chosen = spread(steps, 12);
      const frames: { png: Buffer; label: string }[] = [];
      for (const id of [...new Set(chosen.map((c) => c.id))]) {
        const mine = chosen.filter((c) => c.id === id);
        const got = await video.frames(projectId, id, mine.map((c) => c.t));
        got.forEach((g, i) => frames.push({ png: g.png, label: `${ids.length > 1 ? `${id} · ` : ""}${mine[i].t.toFixed(1)} s · ${mine[i].label}${mine[i].line ? ` · line ${mine[i].line}` : ""}` }));
      }
      if (!frames.length) return text("No rendered video for that scene yet. Call render_preview first.");
      const sheet = await contactSheet(frames, { aspect: vertical ? 9 / 16 : 16 / 9 });
      const findings = ids.flatMap((id) => {
        const tl = video.timeline(projectId, id);
        return tl ? analyseLayout(snapshotsFromTimeline(tl, ids.length > 1 ? id : undefined), { frameHeightPx }) : [];
      });
      return { content: [image(sheet), { type: "text", text: formatFindings(findings, "end of each step") }] };
    },
  );

  // ------------------------------------------------------------------ Lab interaction

  server.registerTool(
    "interact",
    {
      title: "Use the Lab",
      description:
        "Try the Lab like a student: open it fresh in a hidden window, run actions in order, then return a screenshot, the result of each action, console errors, layout checks and the list of controls on the page. Call it with no actions to list the controls. Targets are a data-part name, a CSS selector, or the visible label/text of a control. The teacher's preview is not affected.",
      inputSchema: {
        actions: z
          .array(
            z
              .object({
                click: z.string().optional().describe("Control to click"),
                set: z.string().optional().describe("Slider, input, select or checkbox to set (use with value)"),
                value: z.union([z.string(), z.number(), z.boolean()]).optional(),
                type: z.string().optional().describe("Text field to type into (use with text)"),
                text: z.string().optional(),
                press: z.string().optional().describe('Key to press, e.g. "Enter" or "ArrowRight"'),
                target: z.string().optional().describe("Where to press the key"),
                wait: z.number().max(5000).optional().describe("Milliseconds to wait"),
              })
              .describe('One action, e.g. {"set": "angle", "value": 45}, {"click": "Check"}, {"type": "answer", "text": "12"}, {"press": "Enter"}, {"wait": 500}'),
          )
          .max(20)
          .optional(),
        viewport: z.enum(["desktop", "phone"]).optional(),
      },
    },
    async ({ actions, viewport }) => {
      if (projects.manifest(projectId).kind !== "lab") return text("interact is for Labs. For animations use get_keyframes or get_frames.");
      const steps = (actions ?? []).map((a): LabAction | null =>
        a.click !== undefined ? { click: a.click } : a.set !== undefined ? { set: a.set, value: a.value ?? "" } : a.type !== undefined ? { type: a.type, text: a.text ?? "" } : a.press !== undefined ? { press: a.press, target: a.target } : a.wait !== undefined ? { wait: a.wait } : null,
      );
      const r = await labSession(projectId, { viewport: viewport ?? "desktop", actions: steps.filter((a): a is LabAction => a !== null) });
      const lines = [
        actions?.length ? `Actions:\n${(actions ?? []).map((a, i) => `${i + 1}. ${JSON.stringify(a)} → ${r.results[i] ?? "?"}`).join("\n")}` : "",
        `Controls on the page:\n${r.controls.length ? r.controls.map((c) => `- ${c}`).join("\n") : "- none found"}`,
        formatFindings(r.findings, `${viewport ?? "desktop"} after the actions`),
        formatConsole(r.console),
      ].filter(Boolean);
      return { content: [image(r.png), { type: "text", text: lines.join("\n\n") }] };
    },
  );

  // ------------------------------------------------------------------ the teacher's view

  server.registerTool(
    "get_view",
    {
      title: "See what the teacher sees",
      description:
        "A picture of the preview exactly as the teacher sees it right now (their scene, playhead and selection outline), plus where they are: scene, time, playing or paused, selected part. Use it when the teacher says \"this\", \"here\" or \"what you see now\".",
      inputSchema: {},
    },
    async () => {
      const v = await teacherView(projectId, ctx()?.selection);
      return v.png ? { content: [image(v.png), { type: "text", text: v.text }] } : text(v.text);
    },
  );

  server.registerTool(
    "ask_teacher",
    {
      title: "Ask the teacher",
      description:
        "Ask the teacher 1-4 short multiple-choice questions in the chat and wait for the answers. Each question gets 2-5 concrete options tailored to this topic; the teacher can also type their own answer. Use it when a guided start is requested, or when a choice genuinely changes what you build. Never ask about code.",
      inputSchema: {
        intro: z.string().max(120).optional().describe('One short line above the questions, e.g. "A few quick questions before I start".'),
        questions: z
          .array(
            z.object({
              question: z.string().max(160),
              options: z.array(z.string().max(80)).min(2).max(5),
              multi: z.boolean().optional().describe("Allow picking several options."),
            }),
          )
          .min(1)
          .max(4),
      },
    },
    async ({ intro, questions }) => {
      const ask = ctx()?.ask;
      if (!ask) return text("The teacher isn't available right now. Use your best judgement.");
      const answers = await ask({ intro, questions });
      if (!answers) return text("The teacher skipped the questions. Use your best judgement and mention your choices briefly.");
      return text(questions.map((q, i) => `${q.question}\n→ ${answers[i] || "(no answer: your choice)"}`).join("\n\n"));
    },
  );

  return server;
}

let httpServer: http.Server | undefined;
let baseUrl = "";
const token = randomBytes(24).toString("hex");

/** Start the local MCP endpoint (127.0.0.1 only, random token in the path). */
export async function startToolServer(): Promise<void> {
  if (httpServer) return;
  httpServer = http.createServer(async (req, res) => {
    const m = /^\/mcp\/([0-9a-f-]{36})\/([0-9a-f]+)\/?$/.exec(req.url?.split("?")[0] ?? "");
    if (!m || m[2] !== token) {
      res.writeHead(404).end();
      return;
    }
    const projectId = m[1];
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }
    // Stateless: a fresh server + transport per request, bound to this project.
    const server = createServer(projectId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
  const addr = httpServer.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

export function toolServerUrl(projectId: string): string {
  if (!baseUrl) throw new Error("Tool server not started");
  return `${baseUrl}/mcp/${projectId}/${token}`;
}

export const STUDIO_TOOL_NAMES = ["render_preview", "get_console", "get_frames", "get_keyframes", "interact", "get_view", "get_selection", "ask_teacher"];

/** The preview exactly as the teacher sees it, cut from the app window, plus where they are. */
export async function teacherView(projectId: string, sel: Selection | undefined): Promise<{ png?: Buffer; text: string }> {
  const win = mainWindow();
  const selLine = sel ? `Selected: ${sel.part}${sel.kind ? ` (${sel.kind})` : ""}${sel.source?.line ? `, source line ${sel.source.line}` : ""}.` : "Nothing selected.";
  if (!win) return { text: `The app window isn't available. ${selLine}` };
  const info = (await win.webContents
    .executeJavaScript(
      `(() => { const el = document.querySelector('[data-agent-view][data-project="${projectId}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, ...el.dataset }; })()`,
    )
    .catch(() => null)) as null | { x: number; y: number; w: number; h: number; view?: string; scene?: string; time?: string; totalTime?: string; playing?: string };
  if (!info || info.w < 10) return { text: `The teacher doesn't have this project's preview open right now. ${selLine}` };
  const where = [
    info.view ? `Viewing: ${info.view}` : "",
    info.scene ? `scene “${info.scene}”` : "",
    info.time ? `at ${info.time} s${info.totalTime && info.totalTime !== info.time ? ` (${info.totalTime} s into the whole thing)` : ""}` : "",
    info.playing ? (info.playing === "true" ? "playing" : "paused") : "",
  ]
    .filter(Boolean)
    .join(", ");
  const img = await win.webContents.capturePage({ x: Math.round(info.x), y: Math.round(info.y), width: Math.round(info.w), height: Math.round(info.h) });
  return { png: img.toPNG(), text: `${where}. ${selLine}` };
}
