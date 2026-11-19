import http from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Selection } from "@studio/shared";
import { buildPreview, consoleFor, inspectPreview, type ViewportName } from "../build/preview";
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
      if (m.kind === "video") {
        const r = await video.renderPreview(projectId, scene);
        ctx()?.onPreviewUpdated();
        return text(r.ok ? `Rendered ${r.scene} (${r.durationSec?.toFixed(1)} s) in ${r.seconds.toFixed(1)} s.\n${r.log}` : `Render failed for ${r.scene}:\n${r.log}`);
      }
      const res = await buildPreview(projectId);
      if (!res.ok) return text(`Build failed:\n${res.errors.join("\n")}`);
      ctx()?.onPreviewUpdated();
      const query = m.kind === "web" && scene ? `scene=${encodeURIComponent(scene)}` : "";
      const insp = await inspectPreview(projectId, { times: [m.kind === "web" ? 3 : 1.5], query });
      const kb = Math.round((res.sizeBytes ?? 0) / 1024);
      return text(`Build OK: ${kb} KB, libraries: ${res.libraries?.join(", ") || "none"}.\n${formatConsole(insp.console)}`);
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

export const STUDIO_TOOL_NAMES = ["render_preview", "get_console", "get_frames", "get_selection", "ask_teacher"];
