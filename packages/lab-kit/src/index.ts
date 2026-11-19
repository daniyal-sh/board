/**
 * Lab kit: small, framework-free building blocks for Labs.
 *
 *   import "@studio/lab-kit";            // registers <lab-slider>, <lab-steps>, <lab-check>, <lab-reveal>
 *   import { renderMath } from "@studio/lab-kit/math";   // KaTeX, only when a Lab needs math
 *
 * Every element gets a data-part attribute (from its name or id) so teachers can click it
 * in the preview and ask for a change.
 */
import "./lab-kit.css";

function partName(el: HTMLElement, fallback: string): void {
  if (!el.dataset.part) el.dataset.part = el.getAttribute("name") || el.id || fallback;
}

/** <lab-slider name="angle" label="Angle θ" min="5" max="85" step="1" value="45" unit="°"> */
export class LabSlider extends HTMLElement {
  private input!: HTMLInputElement;
  private out!: HTMLOutputElement;

  connectedCallback(): void {
    if (this.input) return;
    partName(this, "slider");
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.textContent = this.getAttribute("label") ?? this.getAttribute("name") ?? "";
    this.out = document.createElement("output");
    label.append(text, this.out);
    this.input = document.createElement("input");
    this.input.type = "range";
    for (const a of ["min", "max", "step", "value"]) {
      const v = this.getAttribute(a);
      if (v !== null) this.input.setAttribute(a, v);
    }
    this.input.setAttribute("aria-label", text.textContent);
    this.input.addEventListener("input", () => {
      this.show();
      this.dispatchEvent(new CustomEvent("change", { detail: this.value, bubbles: true }));
    });
    this.append(label, this.input);
    this.show();
  }

  get value(): number {
    return this.input ? Number(this.input.value) : Number(this.getAttribute("value") ?? 0);
  }

  set value(v: number) {
    if (this.input) {
      this.input.value = String(v);
      this.show();
    } else this.setAttribute("value", String(v));
  }

  private show(): void {
    const digits = Number(this.getAttribute("digits") ?? (Number(this.getAttribute("step") ?? 1) < 1 ? 2 : 0));
    this.out.textContent = this.value.toFixed(digits) + (this.getAttribute("unit") ?? "");
  }
}

/** <lab-steps> containing <lab-step> children, with Back / Next controls. Fires "step" events. */
export class LabSteps extends HTMLElement {
  private index = 0;
  private nav?: HTMLDivElement;

  connectedCallback(): void {
    if (this.nav) return;
    partName(this, "steps");
    this.nav = document.createElement("div");
    this.nav.className = "lab-steps-nav";
    this.nav.innerHTML =
      '<span class="lab-dots"></span><button class="lab-btn" data-dir="-1">Back</button><button class="lab-btn primary" data-dir="1">Next</button>';
    this.nav.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b) this.go(this.index + Number(b.dataset.dir));
    });
    this.append(this.nav);
    this.go(0);
  }

  get steps(): HTMLElement[] {
    return [...this.querySelectorAll<HTMLElement>(":scope > lab-step")];
  }

  go(i: number): void {
    const steps = this.steps;
    this.index = Math.max(0, Math.min(steps.length - 1, i));
    steps.forEach((s, k) => s.toggleAttribute("active", k === this.index));
    const dots = this.nav!.querySelector(".lab-dots")!;
    dots.innerHTML = steps.map((_, k) => `<i class="${k === this.index ? "on" : ""}"></i>`).join("");
    const [back, next] = this.nav!.querySelectorAll("button");
    back.disabled = this.index === 0;
    next.disabled = this.index === steps.length - 1;
    this.dispatchEvent(new CustomEvent("step", { detail: this.index, bubbles: true }));
  }
}

export class LabStep extends HTMLElement {
  connectedCallback(): void {
    partName(this, "step");
  }
}

/**
 * <lab-check question="Which angle goes farthest?" answer="45°" choices="30°|45°|60°"
 *            explain="Range is largest when sin 2θ = 1, so θ = 45°.">
 */
export class LabCheck extends HTMLElement {
  private built = false;

  connectedCallback(): void {
    if (this.built) return;
    this.built = true;
    partName(this, "check");
    const answer = this.getAttribute("answer") ?? "";
    const choices = (this.getAttribute("choices") ?? "").split("|").map((s) => s.trim()).filter(Boolean);
    const q = document.createElement("div");
    q.className = "lab-q";
    q.textContent = this.getAttribute("question") ?? "";
    const list = document.createElement("div");
    list.className = "lab-choices";
    const feedback = document.createElement("div");
    feedback.className = "lab-feedback";
    feedback.setAttribute("aria-live", "polite");
    for (const c of choices) {
      const b = document.createElement("button");
      b.className = "lab-btn";
      b.dataset.choice = c;
      b.textContent = c;
      b.addEventListener("click", () => {
        const right = c === answer;
        b.classList.add(right ? "right" : "wrong");
        feedback.textContent = right ? this.getAttribute("explain") ?? "Correct!" : this.getAttribute("hint") ?? "Not quite. Try again.";
        this.dispatchEvent(new CustomEvent("answer", { detail: { choice: c, correct: right }, bubbles: true }));
      });
      list.append(b);
    }
    this.prepend(q, list, feedback);
  }
}

/** <lab-reveal label="Predict first, then reveal"><div slot="hidden">…</div></lab-reveal> */
export class LabReveal extends HTMLElement {
  private built = false;

  connectedCallback(): void {
    if (this.built) return;
    this.built = true;
    partName(this, "reveal");
    const b = document.createElement("button");
    b.className = "lab-btn";
    b.textContent = this.getAttribute("label") ?? "Reveal";
    b.addEventListener("click", () => {
      this.toggleAttribute("open");
      b.textContent = this.hasAttribute("open") ? "Hide" : this.getAttribute("label") ?? "Reveal";
    });
    this.prepend(b);
  }
}

const elements: [string, CustomElementConstructor][] = [
  ["lab-slider", LabSlider],
  ["lab-steps", LabSteps],
  ["lab-step", LabStep],
  ["lab-check", LabCheck],
  ["lab-reveal", LabReveal],
];
for (const [name, ctor] of elements) if (!customElements.get(name)) customElements.define(name, ctor);

/** Read a slider by name: `const angle = slider("angle")`. */
export function slider(name: string): LabSlider {
  const el = document.querySelector<LabSlider>(`lab-slider[name="${name}"]`);
  if (!el) throw new Error(`No <lab-slider name="${name}"> on the page`);
  return el;
}

/** Run `fn` now and whenever any of the named sliders change. */
export function watch(names: string[], fn: () => void): void {
  for (const n of names) slider(n).addEventListener("change", fn);
  fn();
}

/** Size a canvas for crisp drawing on high-DPI screens. Returns its 2D context in CSS pixels. */
export function hidpi(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D {
  const r = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * r);
  canvas.height = Math.round(height * r);
  canvas.style.aspectRatio = `${width} / ${height}`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(r, 0, 0, r, 0, 0);
  return ctx;
}

/** requestAnimationFrame loop with delta time in seconds. Returns a stop function. */
export function loop(fn: (dt: number, t: number) => void): () => void {
  let last = performance.now();
  const start = last;
  let id = 0;
  const tick = (now: number) => {
    fn(Math.min(0.05, (now - last) / 1000), (now - start) / 1000);
    last = now;
    id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(id);
}

/** CSS variable value, e.g. color("--manim-blue"). */
export function color(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
