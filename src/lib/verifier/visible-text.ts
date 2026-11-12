/**
 * In-page JavaScript, as a string to embed at the top of a script run with
 * `evaluateIsolated`, that tells text a visitor can see from text that is on
 * the page but hidden. `dom_assert` and `ai_page_judgement` both use it, so
 * neither counts the same hidden text as shown.
 *
 * Defines:
 * - `docW`, `docH`: the document's size in CSS px.
 * - `hiddenReason(textNode, parentElement)`: null if a visitor can see the
 *   text, otherwise why not: "not displayed" (display, visibility, opacity),
 *   "tiny text", "transparent text", "text colour matches background",
 *   "zero-size box", "off-screen", "clipped to a tiny box".
 * - `hiddenTextNodes(root)`: every non-blank text node under `root` that is
 *   hidden, as `{ node, text, reason }` (script, style and SVG text skipped).
 * - `withHiddenTextBlanked(hiddenNodes, read)`: calls `read()` with those
 *   nodes emptied, so `innerText` returns only visible text, then restores them.
 */
export const VISIBLE_TEXT_JS = `
  const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  const parseColor = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || "");
    if (!m) return c === "transparent" ? [0, 0, 0, 0] : null;
    const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = (rgb) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const background = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = parseColor(s.backgroundColor);
      if (c && c[3] > 0.5) return c;
    }
    return [255, 255, 255, 1];
  };
  const hiddenReason = (node, el) => {
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return "not displayed";
    const s = getComputedStyle(el);
    if (parseFloat(s.fontSize) < 5) return "tiny text";
    const fg = parseColor(s.color);
    if (fg && fg[3] < 0.15) return "transparent text";
    const bg = background(el);
    if (fg && bg) {
      const a = lum(fg), b = lum(bg);
      if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 1.25) return "text colour matches background";
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return "zero-size box";
    const x = r.left + window.scrollX, y = r.top + window.scrollY;
    if (x + r.width < 0 || y + r.height < 0 || x > docW || y > docH) return "off-screen";
    for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 8; n = n.parentElement, depth++) {
      const ns = getComputedStyle(n);
      const nr = n.getBoundingClientRect();
      if ((ns.overflow !== "visible" || ns.clipPath !== "none" || ns.clip !== "auto") && (nr.width <= 2 || nr.height <= 2)) return "clipped to a tiny box";
    }
    return null;
  };
  const hiddenTextNodes = (root) => {
    const found = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data;
      if (!text.trim()) continue;
      const el = node.parentElement;
      if (!el || el.closest("script,style,noscript,template,svg")) continue;
      const reason = hiddenReason(node, el);
      if (reason) found.push({ node, text, reason });
    }
    return found;
  };
  const withHiddenTextBlanked = (hiddenNodes, read) => {
    for (const h of hiddenNodes) h.node.data = "";
    try {
      return read();
    } finally {
      for (const h of hiddenNodes) h.node.data = h.text;
    }
  };
`;
