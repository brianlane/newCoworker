import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Node dispatcher and its Deno twin have to agree, and NOTHING ELSE IN
 * THIS REPO CAN TELL YOU WHEN THEY DO NOT.
 *
 * `src/lib/notifications/dispatch.ts` and
 * `supabase/functions/notifications/index.ts` are two implementations of the
 * same fan-out. They declare the channel union separately, they read the
 * preferences row with separate column lists, and `tsconfig.json` excludes
 * `supabase/functions` entirely, so the compiler sees only one of them.
 *
 * The failure that motivated this guard, spelled out because it is quiet in
 * every direction: add a channel, wire it into the Node union and the Node
 * preferences reader, and forget the Deno select string. The owner then
 * switches that channel off. Alerts raised through /api/rowboat respect the
 * toggle. Alerts raised through the edge function keep firing forever,
 * because `prefs.<channel>_urgent` came back `undefined` from a select that
 * never asked for it, and the `?? true` default did the rest. There is no
 * error, no log, and the `notifications` table honestly records `sent` for a
 * channel the owner turned off.
 *
 * These assertions are textual on purpose. A Deno file cannot be imported
 * here, so comparing the source is the only mechanism available; crude beats
 * absent when the alternative is a silent double-send.
 */

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** The string literals in a `type X = "a" | "b";` declaration, in order. */
function unionMembers(source: string, declaration: RegExp): string[] {
  const match = source.match(declaration);
  if (!match) throw new Error(`could not find the declaration ${declaration}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * The columns named in a `.select("a, b, c")` column list that names
 * `anchor`. Matched against whole column names in a comma-separated string
 * rather than the first textual hit: every one of these names also appears
 * in the file as a type field and as a property read, and anchoring on
 * those would silently measure the wrong thing.
 */
function selectColumns(source: string, anchor: string): string[] {
  const lists = [...source.matchAll(/"([^"\n]*)"/g)]
    .map((m) => m[1].split(",").map((c) => c.trim()).filter(Boolean))
    .filter((cols) => cols.length > 1);
  const hit = lists.find((cols) => cols.includes(anchor));
  if (!hit) throw new Error(`could not find a select column list naming ${anchor}`);
  return hit;
}

const NODE_NOTIFICATIONS = read("src/lib/db/notifications.ts");
const NODE_PREFERENCES = read("src/lib/db/notification-preferences.ts");
const DENO_DISPATCH = read("supabase/functions/notifications/index.ts");
const DENO_DIGEST = read("supabase/functions/notifications-digest/index.ts");

const NODE_CHANNELS = unionMembers(
  NODE_NOTIFICATIONS,
  /export type NotificationDeliveryChannel =([^;]+);/
);
const DENO_CHANNELS = unionMembers(DENO_DISPATCH, /\ntype DeliveryChannel =([^;]+);/);

describe("the two dispatchers declare the same channels", () => {
  it("has found a real channel list on both sides", () => {
    // Guards the guard: a rename that made either regex miss would otherwise
    // leave this file comparing two empty arrays and passing forever.
    expect(NODE_CHANNELS.length).toBeGreaterThanOrEqual(5);
    expect(NODE_CHANNELS).toContain("dashboard");
  });

  it("agrees on the channel union, member for member and in the same order", () => {
    expect(DENO_CHANNELS).toEqual(NODE_CHANNELS);
  });

  it("agrees on the delivery status union too", () => {
    const node = unionMembers(NODE_NOTIFICATIONS, /export type NotificationStatus =([^;]+);/);
    const deno = unionMembers(DENO_DISPATCH, /\ntype DeliveryStatus =([^;]+);/);
    expect(deno).toEqual(node);
  });

  it("keeps the database CHECK constraint in step with the union", () => {
    // A channel the code can produce but the constraint rejects turns every
    // send on it into a failed insert, and `notifications` is a residency
    // moved table, so on a residency tenant a rejected row stops the write
    // journal and queues every later write behind it.
    const migrations = read("supabase/migrations/20260822113305_slack_alert_channel.sql");
    for (const channel of NODE_CHANNELS) {
      expect(migrations, `${channel} missing from the delivery_channel CHECK`).toContain(
        `'${channel}'`
      );
    }
  });
});

describe("the Deno reader asks for every preference column it honours", () => {
  /**
   * Every per-channel toggle the Node writer can persist. Derived from the
   * update type rather than hand-listed, so a new channel's column is
   * covered the day it is added rather than the day someone remembers to
   * extend this array.
   */
  const nodeToggles = [
    ...NODE_PREFERENCES.matchAll(/\b(\w+_(?:urgent|digest))\b/g)
  ]
    .map((m) => m[1])
    .filter((name, i, all) => all.indexOf(name) === i)
    .sort();

  it("has found the toggle columns it is meant to be checking", () => {
    expect(nodeToggles).toContain("sms_urgent");
    expect(nodeToggles).toContain("slack_urgent");
    expect(nodeToggles).toContain("email_digest");
  });

  it("selects every *_urgent toggle in the urgent dispatcher", () => {
    const selected = selectColumns(DENO_DISPATCH, "sms_urgent");
    for (const column of nodeToggles.filter((c) => c.endsWith("_urgent"))) {
      expect(
        selected,
        `${column} is honoured by the Node dispatcher but never read by the Deno one, so it silently defaults to ON there`
      ).toContain(column);
    }
  });

  it("selects every *_digest toggle in the digest dispatcher", () => {
    const selected = selectColumns(DENO_DIGEST, "slack_digest");
    for (const column of nodeToggles.filter((c) => c.endsWith("_digest"))) {
      expect(
        selected,
        `${column} is honoured by the Node digest but never read by the Deno one`
      ).toContain(column);
    }
  });
});
