/**
 * New Coworker website chat widget loader.
 *
 * Businesses embed ONE tag on their own site:
 *
 *   <script src="https://newcoworker.com/widget.js" data-key="ncw_pub_..." async></script>
 *
 * This file stays deliberately tiny and dependency-free: it draws the
 * floating chat bubble and lazily injects an <iframe> pointing at
 * /widget/frame (served from the New Coworker origin) the first time the
 * visitor opens it. All chat UI, credentials, and API traffic live inside
 * the iframe — nothing sensitive ever runs in the host page's context, and
 * the host page's CSS cannot leak into the chat.
 */
(function () {
  "use strict";
  if (window.__ncwWidgetLoaded) return;
  window.__ncwWidgetLoaded = true;

  var script = document.currentScript;
  if (!script) return;
  var key = script.getAttribute("data-key") || "";
  if (!/^ncw_pub_[0-9a-f]{64}$/.test(key)) return;

  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch (e) {
    return;
  }
  var accent = script.getAttribute("data-color") || "#0f172a";

  var Z = "2147483000"; // near-max, still leaves headroom for host overlays

  // --- Bubble button -------------------------------------------------
  var btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Open chat");
  btn.style.cssText =
    "position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;" +
    "background:" + accent + ";box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:" + Z + ";" +
    "display:flex;align-items:center;justify-content:center;padding:0;transition:transform .15s ease;";
  btn.innerHTML =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M12 3C7.03 3 3 6.58 3 11c0 2.05.9 3.92 2.37 5.33-.13 1.05-.53 2.3-1.37 3.42 0 0 2.42-.23 4.2-1.36.88.25 1.82.39 2.8.39 4.97 0 9-3.58 9-8s-4.03-8-9-8Z" fill="#fff"/></svg>';
  btn.onmouseenter = function () { btn.style.transform = "scale(1.06)"; };
  btn.onmouseleave = function () { btn.style.transform = "scale(1)"; };

  // --- Iframe panel (created lazily on first open) --------------------
  var frame = null;
  var open = false;

  function panelStyle() {
    var mobile = window.innerWidth < 480;
    return (
      "position:fixed;border:0;z-index:" + Z + ";box-shadow:0 12px 40px rgba(0,0,0,.28);" +
      "background:#fff;transition:opacity .15s ease;" +
      (mobile
        ? "inset:0;width:100%;height:100%;border-radius:0;"
        : "bottom:88px;right:20px;width:380px;height:min(600px,calc(100vh - 110px));border-radius:16px;")
    );
  }

  function ensureFrame() {
    if (frame) return;
    frame = document.createElement("iframe");
    frame.src = origin + "/widget/frame?key=" + encodeURIComponent(key);
    frame.title = "Chat";
    frame.allow = "clipboard-write";
    frame.style.cssText = panelStyle() + "display:none;";
    document.body.appendChild(frame);
    window.addEventListener("resize", function () {
      if (frame) frame.style.cssText = panelStyle() + (open ? "" : "display:none;");
    });
  }

  function setOpen(next) {
    open = next;
    if (open) {
      ensureFrame();
      frame.style.cssText = panelStyle();
      btn.setAttribute("aria-label", "Close chat");
    } else if (frame) {
      frame.style.cssText = panelStyle() + "display:none;";
      btn.setAttribute("aria-label", "Open chat");
    }
  }

  btn.addEventListener("click", function () { setOpen(!open); });

  // The frame's header close button posts up to us.
  window.addEventListener("message", function (ev) {
    if (ev.origin !== origin) return;
    if (ev.data && ev.data.type === "ncw:close") setOpen(false);
  });

  function mount() { document.body.appendChild(btn); }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
