/**
 * Injected into preview builds only (never into exported or published files).
 * - Forwards console output and errors to the app.
 * - "Select" mode: hovering outlines the nearest [data-part]; clicking reports it instead of interacting.
 */
export const PREVIEW_BRIDGE = String.raw`(function () {
  window.__studioPreview = true;
  var post = function (m) { m.__studio = 1; try { parent.postMessage(m, "*"); } catch (e) {} };
  var fmt = function (v) {
    if (v instanceof Error) return v.stack || v.message;
    if (typeof v === "object") { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  };
  ["log", "info", "warn", "error"].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      post({ type: "console", level: level, text: args.map(fmt).join(" ") });
      return orig.apply(console, args);
    };
  });
  addEventListener("error", function (e) {
    post({ type: "console", level: "error", text: (e.message || "Error") + (e.lineno ? " (line " + e.lineno + ")" : "") });
  });
  addEventListener("unhandledrejection", function (e) {
    var r = e.reason; post({ type: "console", level: "error", text: "Unhandled promise rejection: " + (r && r.stack ? r.stack : String(r)) });
  });

  var picking = false, box = null, current = null;
  function ensureBox() {
    if (box) return box;
    box = document.createElement("div");
    box.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #5146E5;border-radius:6px;box-shadow:0 0 0 4px rgba(81,70,229,.18);transition:all .08s;display:none";
    var tag = document.createElement("span");
    tag.style.cssText = "position:absolute;left:-2px;top:-22px;background:#5146E5;color:#fff;font:600 11px/1.6 ui-monospace,monospace;padding:0 6px;border-radius:4px 4px 4px 0;white-space:nowrap";
    box.appendChild(tag);
    document.documentElement.appendChild(box);
    return box;
  }
  function partOf(el) { return el && el.closest ? el.closest("[data-part]") : null; }
  function show(el) {
    var b = ensureBox();
    if (!el) { b.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    b.style.display = "block";
    b.style.left = r.left - 4 + "px"; b.style.top = r.top - 4 + "px";
    b.style.width = r.width + 8 + "px"; b.style.height = r.height + 8 + "px";
    b.firstChild.textContent = el.getAttribute("data-part");
  }
  addEventListener("mousemove", function (e) {
    if (!picking) return;
    var el = partOf(e.target);
    if (el !== current) { current = el; show(el); }
  }, true);
  addEventListener("click", function (e) {
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    var el = partOf(e.target);
    if (!el) return;
    var text = (el.innerText || "").trim().slice(0, 140);
    post({ type: "select", part: el.getAttribute("data-part"), tag: el.tagName.toLowerCase(), text: text });
  }, true);
  addEventListener("message", function (e) {
    var d = e.data;
    if (!d || !d.__studio) return;
    if (d.type === "pick") {
      picking = !!d.on;
      document.documentElement.style.cursor = picking ? "crosshair" : "";
      if (!picking) { current = null; show(null); }
    }
  });
  addEventListener("load", function () { post({ type: "ready" }); });
})();`;
