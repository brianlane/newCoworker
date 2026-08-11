/**
 * The shared shell every inline widget is built from.
 *
 * A widget is a whole HTML document registered once as an MCP resource under a
 * `ui://` URI. ChatGPT loads it in an iframe and hands it the tool's result at
 * runtime through `window.openai`, so these are NOT server-rendered per call:
 * the markup is static and the data arrives client-side.
 *
 * Three constraints shape everything here, and each one is a rule rather than
 * a preference:
 *
 * 1. **Self-contained.** No external stylesheet, font, script or image. The
 *    Content Security Policy declared at submission is what a reviewer checks,
 *    and the narrowest one to defend is the one that allows nothing.
 * 2. **Never `innerHTML`.** Widgets render customer-supplied text: names,
 *    message bodies, call transcripts. Building DOM with `textContent` is what
 *    keeps a contact named `<img onerror=...>` from being markup, and
 *    `tests/mcp-widgets.test.ts` fails the build if `innerHTML` appears.
 * 3. **Both themes.** ChatGPT renders light and dark, and a widget that
 *    assumed one is unreadable in the other.
 */

/** Wrap a widget body in the shared document, styles and bootstrap. */
export function widgetDocument(options: { title: string; body: string; script: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${options.title}</title>
<style>
:root{color-scheme:light dark;--fg:#101014;--muted:#5c5f6b;--line:#e4e5ea;--card:#fff;--accent:#0b7a6b}
@media (prefers-color-scheme:dark){:root{--fg:#ecedf1;--muted:#9a9daa;--line:#2a2c34;--card:#17181d;--accent:#4fd1bd}}
*{box-sizing:border-box}
body{margin:0;padding:12px;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:transparent}
.card{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:14px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.muted{color:var(--muted);font-size:12px}
.title{font-weight:600;font-size:15px}
.stack{display:flex;flex-direction:column;gap:8px}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:10px;padding:8px 12px}
button:hover{border-color:var(--accent)}
button[disabled]{opacity:.55;cursor:default}
.slot{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.msg{padding:8px 10px;border-radius:10px;max-width:85%;white-space:pre-wrap;word-break:break-word}
.in{align-self:flex-start;border:1px solid var(--line)}
.out{align-self:flex-end;background:var(--accent);color:#fff}
.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--muted)}
.empty{color:var(--muted);font-size:13px;padding:6px 0}
</style>
</head>
<body>
<div id="root" class="card">${options.body}</div>
<script type="module">
// The host hands the tool result over in two ways depending on its age: a
// property on window.openai, and a postMessage notification. Read both, and
// re-render on the notification, so the widget is not blank on whichever one
// this client happens to use.
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  // textContent, never innerHTML: every string below is customer data.
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};
const readOutput = () => {
  try { return window.openai?.toolOutput ?? window.openai?.widgetState ?? null; }
  catch { return null; }
};
${options.script}
const boot = (data) => { try { render(data); } catch { /* a malformed payload must not blank the card */ } };
boot(readOutput());
window.addEventListener("message", (event) => {
  const params = event?.data?.params;
  if (params && typeof params === "object" && "structuredContent" in params) {
    boot(params.structuredContent);
  }
});
</script>
</body>
</html>`;
}
