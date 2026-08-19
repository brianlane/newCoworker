/**
 * Read a rendered page's markup and report the controls a `browse_action`
 * step could actually aim at: buttons, links, dropdowns and their options,
 * text fields, and stable `data-test` handles.
 *
 * Authoring a browse step means naming a real selector. Guessing one is how
 * `debug/update-amy-aiflow-re-update-actions.ts` came to exist: the first
 * ReferralExchange update sequence was written blind, the note field turned
 * out to be `textarea[name="message"]` rather than a placeholder, and the
 * step timed out on action 4 in production for weeks. `debug/portal-dom-probe.ts`
 * was the engineer's answer to that; this module is the same digest, moved
 * where the dashboard can serve it to the owner, and where it is covered by
 * tests instead of by running it against a live portal.
 *
 * Pure: markup in, a pickable list out. No IO. Regex rather than a DOM
 * parser on purpose: this is a digest for a human to choose from, never a
 * sanitizer and never rendered as HTML, so a missed edge case costs a missing
 * row in a picker, not correctness anywhere else.
 */

/** The `browse_action` kinds a discovered control can be turned into. */
export type PageControlKind =
  | "click_text"
  | "click_selector"
  | "fill_selector"
  | "fill_placeholder"
  | "select_option";

/** Picker groups, in the order the panel shows them. */
export const PAGE_CONTROL_GROUPS = [
  "Buttons",
  "Dropdowns",
  "Text fields",
  "Stable handles"
] as const;

export type PageControlGroup = (typeof PAGE_CONTROL_GROUPS)[number];

/** One row of the picker: click it and the step gains exactly this action. */
export type PageControl = {
  group: PageControlGroup;
  /** The action kind to write into the step. */
  kind: PageControlKind;
  /** What goes in the action's `target`. */
  target: string;
  /** What the owner reads in the picker. */
  label: string;
  /**
   * The option labels a `<select>` offers, so `select_option`'s value can be
   * picked from the real list rather than typed from memory.
   */
  options?: string[];
};

export type PageLink = { href: string; label: string };

export type PageDigest = {
  controls: PageControl[];
  /** Off-page links, for finding the next page to probe. */
  links: PageLink[];
  /** Headings, so the owner can confirm they are looking at the right page. */
  headings: string[];
};

/** Longest label we keep; portal buttons wrapping whole rows get long. */
const LABEL_MAX = 120;
/** Caps per group, so one list page cannot produce a thousand-row picker. */
const PER_GROUP_MAX = 60;
const LINKS_MAX = 60;
const HEADINGS_MAX = 20;

/**
 * Strip `<script>`/`<style>` so their contents never reach the picker.
 *
 * The end-tag pattern allows trailing junk (`</script foo>` is valid HTML and
 * a naive `</script>` walks straight past it), and the whole thing repeats
 * until the string stops changing, because one pass over nested or
 * overlapping markup can reveal a further opening tag.
 */
export function stripCode(html: string): string {
  const patterns = [/<script\b[\s\S]*?<\/script\b[^>]*>/gi, /<style\b[\s\S]*?<\/style\b[^>]*>/gi];
  let out = html;
  for (let pass = 0; pass < 5; pass++) {
    const before = out;
    for (const re of patterns) out = out.replace(re, " ");
    if (out === before) break;
  }
  return out;
}

/** The handful of entities these portals actually emit. */
const HTML_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
  "&#x27;": "'",
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">"
};

/**
 * Built FROM the table above rather than written out beside it, so the two
 * cannot drift into a match with no replacement. Every key is literal in a
 * regex (`&`, `#`, `;` carry no special meaning), so no escaping is needed.
 */
const ENTITY_RE = new RegExp(Object.keys(HTML_ENTITIES).join("|"), "gi");

/** Visible text of a markup fragment. */
export function textOf(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, " ")
    // ONE pass over all entities. Decoding sequentially (&amp; to & before
    // handling the rest) lets an already-decoded "&" combine with following
    // text into a second entity and be unescaped twice, so "&amp;lt;" would
    // wrongly become "<" instead of "&lt;".
    .replace(ENTITY_RE, (m) => HTML_ENTITIES[m.toLowerCase()])
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag: string, name: string): string {
  return new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1] ?? "";
}

/** First non-empty of the given values. */
function firstOf(...values: string[]): string {
  return values.find((v) => v.length > 0) ?? "";
}

/** Dedupe by target+kind, keep insertion order, and cap the group. */
function take(controls: PageControl[]): PageControl[] {
  const seen = new Set<string>();
  const out: PageControl[] = [];
  for (const c of controls) {
    if (c.target.length === 0) continue;
    const key = `${c.kind}::${c.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= PER_GROUP_MAX) break;
  }
  return out;
}

function buttons(body: string): PageControl[] {
  const found: PageControl[] = [];
  for (const m of body.matchAll(/<button[^>]*>([\s\S]{0,300}?)<\/button>/gi)) {
    // A button with no text (an icon-only one) has nothing to click BY text,
    // so fall back to its aria-label, which is what such buttons carry.
    const text = firstOf(textOf(m[1]), attr(m[0], "aria-label")).slice(0, LABEL_MAX);
    found.push({ group: "Buttons", kind: "click_text", target: text, label: text });
  }
  for (const m of body.matchAll(/<input[^>]*type="(submit|button)"[^>]*>/gi)) {
    const value = attr(m[0], "value").slice(0, LABEL_MAX);
    found.push({ group: "Buttons", kind: "click_text", target: value, label: value });
  }
  return take(found);
}

function dropdowns(body: string): PageControl[] {
  const found: PageControl[] = [];
  // The open tag is CAPTURED rather than re-matched out of the whole element:
  // re-matching needs a "no open tag" fallback that cannot happen.
  for (const m of body.matchAll(/(<select[^>]*>)([\s\S]*?)<\/select>/gi)) {
    const [, open, inner] = m;
    const name = attr(open, "name");
    const id = attr(open, "id");
    // Prefer name over id: a name is the form contract, while SPA ids are
    // often build-time hashes that change on the vendor's next deploy.
    const target = name ? `select[name="${name}"]` : id ? `#${id}` : "";
    const options = [...inner.matchAll(/<option[^>]*>([\s\S]{0,120}?)<\/option>/gi)]
      .map((o) => firstOf(textOf(o[1]), attr(o[0], "value")))
      .filter((o) => o.length > 0)
      .slice(0, 40);
    found.push({
      group: "Dropdowns",
      kind: "select_option",
      target,
      label: target,
      options
    });
  }
  return take(found);
}

function textFields(body: string): PageControl[] {
  const found: PageControl[] = [];
  const collect = (tag: string, element: "input" | "textarea"): void => {
    const type = element === "input" ? firstOf(attr(tag, "type"), "text") : "textarea";
    // Never offer a credential field: a flow typing into one would be
    // storing a password in a step template.
    if (type === "password" || type === "hidden") return;
    const name = attr(tag, "name");
    const placeholder = attr(tag, "placeholder");
    if (name) {
      found.push({
        group: "Text fields",
        kind: "fill_selector",
        target: `${element}[name="${name}"]`,
        label: `${element}[name="${name}"]${placeholder ? ` (${placeholder})` : ""}`
      });
    } else if (placeholder) {
      // No name to select on, but the placeholder is visible and stable
      // enough to aim at, which is exactly what fill_placeholder is for.
      found.push({
        group: "Text fields",
        kind: "fill_placeholder",
        target: placeholder,
        label: `${element} with placeholder "${placeholder}"`
      });
    }
  };
  for (const m of body.matchAll(/<input[^>]*>/gi)) collect(m[0], "input");
  for (const m of body.matchAll(/<textarea[^>]*>/gi)) collect(m[0], "textarea");
  return take(found);
}

function stableHandles(body: string): PageControl[] {
  // data-test / data-testid is the vendor's own stable handle (HomeLight's
  // claim steps already key on it). The sc-* classes beside it are
  // styled-components build hashes and must never become selectors.
  const found: PageControl[] = [];
  for (const m of body.matchAll(/data-test(?:id)?="([^"]+)"/gi)) {
    const which = /data-testid=/i.test(m[0]) ? "data-testid" : "data-test";
    const target = `[${which}="${m[1]}"]`;
    found.push({ group: "Stable handles", kind: "click_selector", target, label: target });
  }
  return take(found);
}

function links(body: string): PageLink[] {
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const m of body.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const href = m[1];
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
    if (/\.(css|js|png|jpe?g|svg|ico|woff2?)($|\?)/i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ href, label: textOf(m[2]).slice(0, LABEL_MAX) });
    if (out.length >= LINKS_MAX) break;
  }
  return out;
}

function headings(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(/<h[1-4][^>]*>([\s\S]{0,200}?)<\/h[1-4]>/gi)) {
    const text = textOf(m[1]).slice(0, LABEL_MAX);
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= HEADINGS_MAX) break;
  }
  return out;
}

/** Digest a rendered page into the controls a browse step can aim at. */
export function digestPageControls(html: string): PageDigest {
  const body = stripCode(html);
  return {
    controls: [
      ...buttons(body),
      ...dropdowns(body),
      ...textFields(body),
      ...stableHandles(body)
    ],
    links: links(body),
    headings: headings(body)
  };
}
