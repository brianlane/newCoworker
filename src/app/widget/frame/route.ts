/**
 * GET /widget/frame?key=ncw_pub_… — the embeddable chat UI document.
 *
 * A ROUTE HANDLER (not a React page) on purpose: the response must carry a
 * PER-TENANT `Content-Security-Policy: frame-ancestors …` header built from
 * chat_widget_settings.allowed_origins, and App Router pages cannot set
 * response headers. The global no-framing headers exclude exactly this path
 * (see next.config.ts) so the dynamic value below is the only CSP here —
 * the BROWSER is what stops an unapproved site from embedding the widget.
 *
 * The document is a small self-contained HTML+CSS+JS chat client (no React,
 * no bundle): pre-chat form when the owner requires it, message list, and
 * reply polling that runs ONLY while a turn is in flight AND the tab is
 * visible, with backoff — no standing poll loop.
 */

import {
  frameAncestorsValue,
  refererAllowedForFrame,
  resolveWidgetContext
} from "@/lib/webchat/service";
import { parseWidgetTheme } from "@/lib/webchat/settings-schema";
import { WEBCHAT_MAX_MESSAGE_CHARS } from "@/lib/webchat/prompt";
import { handleRouteError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlResponse(html: string, frameAncestors: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `frame-ancestors ${frameAncestors}; base-uri 'self'; object-src 'none'`
    }
  });
}

/** Minimal document for invalid-key / disabled / blocked-referer states. */
function unavailableHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Chat</title>
<style>body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh}p{color:#64748b;font-size:14px;text-align:center;padding:0 24px}</style>
</head><body><p>${escapeHtml(message)}</p></body></html>`;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key") ?? "";

    const ctx = await resolveWidgetContext({ key });
    if (!ctx.ok) {
      const message =
        ctx.reason === "offline"
          ? "Chat is offline right now. Please try again later."
          : "This chat widget is not available.";
      // Unavailable documents carry no tenant data — any ancestor may frame
      // them (the copy is the whole point).
      return htmlResponse(unavailableHtml(message), "*");
    }

    const allowedOrigins = ctx.settings.allowed_origins ?? [];

    // Soft referer gate: when the parent page's origin is present and
    // off-list, refuse before rendering. The CSP below is the hard gate.
    if (!refererAllowedForFrame(request.headers.get("referer"), allowedOrigins)) {
      return htmlResponse(
        unavailableHtml("This chat widget is not available on this site."),
        frameAncestorsValue(allowedOrigins)
      );
    }

    const theme = parseWidgetTheme(ctx.settings.theme);
    const accent = theme?.accentColor ?? "#0f172a";
    const displayName = theme?.agentDisplayName || `${ctx.business.name} assistant`;
    const greeting =
      theme?.greeting || `Hi! I'm the ${ctx.business.name} assistant. How can I help?`;

    const config = {
      key,
      requireContactForm: Boolean(ctx.settings.require_contact_form),
      accent,
      displayName,
      greeting,
      maxMessageChars: WEBCHAT_MAX_MESSAGE_CHARS
    };

    // NOTE: config values are embedded two ways — HTML-escaped for static
    // markup, JSON-in-<script> for the client code. The JSON blob escapes
    // `<` so a malicious greeting can't close the script tag.
    const configJson = JSON.stringify(config).replace(/</g, "\\u003c");

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(displayName)}</title>
<style>
  :root { --accent: ${accent}; }
  * { box-sizing: border-box; }
  /* The gate/msgs/send-form sections toggle via the HTML hidden attribute,
     but their author-level display:flex would override the UA stylesheet's
     weak [hidden] { display:none } — making "hidden" purely decorative (the
     pre-chat form rendered on top of the chat in production). Re-assert it
     with importance so the attribute always wins. */
  [hidden] { display: none !important; }
  html, body { height: 100%; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #fff; display: flex; flex-direction: column; }
  .hdr { background: var(--accent); color: #fff; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; }
  .hdr .t { font-size: 15px; font-weight: 600; }
  .hdr button { background: none; border: 0; color: #fff; font-size: 20px; line-height: 1; cursor: pointer; padding: 4px; opacity: .85; }
  .hdr button:hover { opacity: 1; }
  .msgs { flex: 1 1 auto; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: #f8fafc; }
  .m { max-width: 82%; padding: 9px 13px; border-radius: 14px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
  .m.a { background: #fff; border: 1px solid #e2e8f0; color: #0f172a; align-self: flex-start; border-bottom-left-radius: 4px; }
  .m.u { background: var(--accent); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
  .m.sys { background: transparent; color: #94a3b8; font-size: 12px; align-self: center; text-align: center; }
  .typing { align-self: flex-start; color: #94a3b8; font-size: 13px; padding: 4px 13px; display: none; }
  .typing.on { display: block; }
  form.send { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e2e8f0; flex: 0 0 auto; }
  form.send textarea { flex: 1; resize: none; border: 1px solid #cbd5e1; border-radius: 10px; padding: 9px 12px; font: inherit; font-size: 14px; max-height: 90px; outline: none; }
  form.send textarea:focus { border-color: var(--accent); }
  form.send button { background: var(--accent); color: #fff; border: 0; border-radius: 10px; padding: 0 16px; font-size: 14px; font-weight: 600; cursor: pointer; }
  form.send button:disabled { opacity: .5; cursor: default; }
  .gate { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 24px; gap: 10px; background: #f8fafc; }
  .gate h2 { margin: 0 0 2px; font-size: 16px; color: #0f172a; }
  .gate p { margin: 0 0 10px; font-size: 13px; color: #64748b; }
  .gate input { border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 12px; font: inherit; font-size: 14px; outline: none; }
  .gate input:focus { border-color: var(--accent); }
  .gate button { margin-top: 6px; background: var(--accent); color: #fff; border: 0; border-radius: 10px; padding: 11px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .gate .err { color: #dc2626; font-size: 12px; min-height: 15px; margin: 0; }
  .foot { text-align: center; font-size: 10px; color: #cbd5e1; padding: 0 0 6px; flex: 0 0 auto; background: #fff; }
  .foot a { color: #94a3b8; text-decoration: none; }
</style>
</head>
<body>
  <div class="hdr">
    <span class="t">${escapeHtml(displayName)}</span>
    <button type="button" id="closeBtn" aria-label="Close chat">&#215;</button>
  </div>
  <div class="gate" id="gate" hidden>
    <h2>Start the chat</h2>
    <p>Tell us who you are and we'll be right with you.</p>
    <input id="gName" type="text" placeholder="Your name" maxlength="200" autocomplete="name">
    <input id="gEmail" type="email" placeholder="Email" maxlength="320" autocomplete="email">
    <input id="gPhone" type="tel" placeholder="Phone (optional)" maxlength="32" autocomplete="tel">
    <p class="err" id="gErr"></p>
    <button type="button" id="gStart">Start chat</button>
  </div>
  <div class="msgs" id="msgs" hidden></div>
  <div class="typing" id="typing">typing&#8230;</div>
  <form class="send" id="sendForm" hidden>
    <textarea id="input" rows="1" placeholder="Type a message&#8230;" maxlength="2000"></textarea>
    <button type="submit" id="sendBtn">Send</button>
  </form>
  <div class="foot">Powered by <a href="https://newcoworker.com" target="_blank" rel="noopener">New Coworker</a></div>
  <script id="cfg" type="application/json">${configJson}</script>
  <script>
  (function () {
    "use strict";
    var cfg = JSON.parse(document.getElementById("cfg").textContent);
    var storeKey = "ncw_webchat_" + cfg.key.slice(8, 20);
    var gate = document.getElementById("gate");
    var msgs = document.getElementById("msgs");
    var typing = document.getElementById("typing");
    var sendForm = document.getElementById("sendForm");
    var input = document.getElementById("input");
    var sendBtn = document.getElementById("sendBtn");
    var session = null; // { token, sessionId }
    var lastMsgId = 0;
    var polling = false;
    var pendingJob = null;
    var meta = null;        // loader-collected visitor context (host page)
    var currentPage = null; // the page the visitor is on right now

    try { session = JSON.parse(sessionStorage.getItem(storeKey) || "null"); } catch (e) { session = null; }

    document.getElementById("closeBtn").addEventListener("click", function () {
      if (window.parent !== window) window.parent.postMessage({ type: "ncw:close" }, "*");
    });

    // Visitor context arrives from the LOADER on the host page (the only
    // place that can see the page URL / referrer / campaign params). Only
    // the direct parent is trusted as a sender; the payload is validated
    // server-side regardless.
    window.addEventListener("message", function (ev) {
      if (ev.source !== window.parent) return;
      var d = ev.data;
      if (!d) return;
      if (d.type === "ncw:meta" && d.meta && typeof d.meta === "object" && !meta) {
        meta = d.meta;
        if (typeof d.meta.page === "string") currentPage = d.meta.page;
      }
      if (d.type === "ncw:page" && typeof d.page === "string") {
        currentPage = d.page;
      }
    });
    if (window.parent !== window) window.parent.postMessage({ type: "ncw:ready" }, "*");

    function el(role, text) {
      var d = document.createElement("div");
      d.className = "m " + (role === "user" ? "u" : role === "assistant" ? "a" : "sys");
      d.textContent = text;
      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;
      return d;
    }

    function showChat() {
      gate.hidden = true;
      msgs.hidden = false;
      sendForm.hidden = false;
      if (!msgs.childElementCount) el("assistant", cfg.greeting);
      input.focus();
    }

    function showGate() {
      gate.hidden = false;
      msgs.hidden = true;
      sendForm.hidden = true;
    }

    function api(path, opts) {
      opts = opts || {};
      opts.headers = opts.headers || {};
      if (session && session.token) opts.headers["Authorization"] = "Bearer " + session.token;
      if (opts.body) opts.headers["Content-Type"] = "application/json";
      return fetch(path, opts).then(function (res) {
        return res.json().then(function (json) { return { status: res.status, json: json }; });
      });
    }

    function startSession(contact) {
      return api("/api/widget/session", {
        method: "POST",
        body: JSON.stringify({ key: cfg.key, contact: contact, meta: meta || undefined })
      }).then(function (r) {
        if (r.status === 200 && r.json && r.json.ok && r.json.data.status === "ok") {
          session = { token: r.json.data.sessionToken, sessionId: r.json.data.sessionId };
          try { sessionStorage.setItem(storeKey, JSON.stringify(session)); } catch (e) { /* private mode */ }
          return true;
        }
        if (r.json && r.json.ok && r.json.data.status === "offline") {
          el("sys", "Chat is offline right now. Please try again later.");
          return false;
        }
        var msg = (r.json && r.json.error && r.json.error.message) || "Could not start the chat.";
        throw new Error(msg);
      });
    }

    function clearSession() {
      session = null;
      try { sessionStorage.removeItem(storeKey); } catch (e) { /* ignore */ }
    }

    function hydrate() {
      // Returning visitor: re-render the transcript. A 401 means the
      // session expired server-side — drop it and start over.
      api("/api/widget/poll?key=" + encodeURIComponent(cfg.key) + "&after=0", { method: "GET" })
        .then(function (r) {
          if (r.status === 401) { clearSession(); init(); return; }
          if (r.json && r.json.ok) {
            (r.json.data.messages || []).forEach(function (m) {
              if (m.role !== "system") el(m.role, m.content);
              if (m.id > lastMsgId) lastMsgId = m.id;
            });
          }
          showChat();
        })
        .catch(function () { showChat(); });
    }

    // --- Reply polling: ONLY while a job is in flight AND the tab is
    // visible. Backoff 1s → 5s cap; hard stop after 5 minutes.
    function pollLoop() {
      if (polling || !pendingJob) return;
      polling = true;
      var delay = 1000;
      var startedAt = Date.now();
      function tick() {
        if (!pendingJob) { polling = false; return; }
        if (document.visibilityState !== "visible") {
          // Paused — visibilitychange resumes us.
          polling = false;
          return;
        }
        if (Date.now() - startedAt > 5 * 60 * 1000) {
          el("sys", "This is taking longer than expected. Your message was received.");
          finishTurn();
          return;
        }
        api("/api/widget/poll?key=" + encodeURIComponent(cfg.key) +
            "&jobId=" + encodeURIComponent(pendingJob) +
            "&after=" + lastMsgId, { method: "GET" })
          .then(function (r) {
            if (r.status === 401) { clearSession(); el("sys", "Session expired — please send that again."); finishTurn(); showGateIfNeeded(); return; }
            if (!(r.json && r.json.ok)) { schedule(); return; }
            var d = r.json.data;
            (d.messages || []).forEach(function (m) {
              if (m.role === "assistant") el("assistant", m.content);
              if (m.id > lastMsgId) lastMsgId = m.id;
            });
            if (d.status === "done") { finishTurn(); return; }
            if (d.status === "error") { el("sys", d.errorMessage || "Something went wrong — please try again."); finishTurn(); return; }
            schedule();
          })
          .catch(function () { schedule(); });
      }
      function schedule() {
        delay = Math.min(delay * 1.4, 5000);
        setTimeout(tick, delay);
      }
      setTimeout(tick, delay);
    }

    function finishTurn() {
      pendingJob = null;
      polling = false;
      typing.classList.remove("on");
      sendBtn.disabled = false;
    }

    function showGateIfNeeded() {
      if (cfg.requireContactForm && !session) showGate();
    }

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && pendingJob && !polling) pollLoop();
    });

    function mintId() {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
      // RFC4122-shaped fallback for very old engines.
      return "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, function () {
        return Math.floor(Math.random() * 16).toString(16);
      });
    }

    function send(text) {
      // One idempotency key per send. A network-failed POST is retried
      // once with the SAME id — the server dedupes on it, so a request
      // that actually landed is replayed, never duplicated.
      var clientMessageId = mintId();
      var doSend = function (isRetry) {
        if (!isRetry) {
          el("user", text);
          typing.classList.add("on");
          sendBtn.disabled = true;
        }
        api("/api/widget/message", {
          method: "POST",
          body: JSON.stringify({ key: cfg.key, message: text, clientMessageId: clientMessageId, page: currentPage || undefined })
        }).then(function (r) {
          if (r.status === 401) {
            clearSession();
            typing.classList.remove("on");
            sendBtn.disabled = false;
            el("sys", "Session expired — please send that again.");
            showGateIfNeeded();
            return;
          }
          if (r.status === 403) {
            // Server-side contact gate: this session must provide details
            // before chatting (flag flipped after the session started, or
            // the stored session predates the requirement).
            clearSession();
            typing.classList.remove("on");
            sendBtn.disabled = false;
            el("sys", "Please share your details to continue the chat.");
            showGate();
            return;
          }
          if (r.json && r.json.ok) {
            if (r.json.data.userMessageId > lastMsgId) lastMsgId = r.json.data.userMessageId;
            if (r.json.data.jobId) {
              pendingJob = r.json.data.jobId;
              pollLoop();
            } else {
              finishTurn();
            }
            return;
          }
          typing.classList.remove("on");
          sendBtn.disabled = false;
          el("sys", (r.json && r.json.error && r.json.error.message) || "Could not send — please try again.");
        }).catch(function () {
          if (!isRetry) {
            // Transient network blip: one automatic same-id retry.
            setTimeout(function () { doSend(true); }, 1500);
            return;
          }
          typing.classList.remove("on");
          sendBtn.disabled = false;
          el("sys", "Could not send — please check your connection and try again.");
        });
      };
      if (session) { doSend(false); return; }
      // Anonymous mode: lazily mint the session on the first message.
      startSession({}).then(function (ok) { if (ok) doSend(false); })
        .catch(function (e) { el("sys", e.message); });
    }

    sendForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var text = input.value.trim();
      if (!text || pendingJob) return;
      if (text.length > cfg.maxMessageChars) text = text.slice(0, cfg.maxMessageChars);
      input.value = "";
      send(text);
    });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        sendForm.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    });

    document.getElementById("gStart").addEventListener("click", function () {
      var name = document.getElementById("gName").value.trim();
      var email = document.getElementById("gEmail").value.trim();
      var phone = document.getElementById("gPhone").value.trim();
      var err = document.getElementById("gErr");
      if (!name || (!email && !phone)) {
        err.textContent = "Please enter your name and an email or phone number.";
        return;
      }
      err.textContent = "";
      startSession({ name: name, email: email || undefined, phone: phone || undefined })
        .then(function (ok) { if (ok) showChat(); })
        .catch(function (e) { err.textContent = e.message; });
    });

    function init() {
      if (session) { hydrate(); return; }
      if (cfg.requireContactForm) { showGate(); return; }
      showChat();
    }
    init();
  })();
  </script>
</body>
</html>`;

    return htmlResponse(html, frameAncestorsValue(allowedOrigins));
  } catch (err) {
    return handleRouteError(err);
  }
}
