/**
 * Math typesetting with KaTeX. Import only when a Lab shows math:
 *
 *   import { renderMath, tex } from "@studio/lab-kit/math";
 *   renderMath();                 // typesets $...$ and $$...$$ in the page
 *   el.innerHTML = tex("R = \\frac{v^2 \\sin 2\\theta}{g}");
 */
import katex from "katex";
import "katex/dist/katex.min.css";

export function tex(src: string, displayMode = false): string {
  return katex.renderToString(src, { displayMode, throwOnError: false, output: "html" });
}

const PATTERN = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;

/** Replace $inline$ and $$display$$ math in text nodes under `root`. Skips code, scripts and inputs. */
export function renderMath(root: ParentNode = document.body): void {
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || p.closest("script,style,code,pre,textarea,.katex")) return NodeFilter.FILTER_REJECT;
      return n.nodeValue && n.nodeValue.includes("$") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue!;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(PATTERN)) {
      frag.append(text.slice(last, m.index));
      const span = document.createElement(m[1] ? "div" : "span");
      if (m[1]) span.className = "lab-math-block";
      span.innerHTML = tex((m[1] ?? m[2]).trim(), Boolean(m[1]));
      frag.append(span);
      last = m.index! + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}
