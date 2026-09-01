import { readdirSync, readFileSync } from "node:fs";
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
    //
    // The LATEST migration that re-adds the constraint is the one in force,
    // found rather than named: pinning a filename here would have made this
    // assertion go stale the first time a channel widened it, which is
    // precisely when it needs to be right.
    const dir = join(ROOT, "supabase/migrations");
    const defining = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) =>
        readFileSync(join(dir, f), "utf8").includes(
          "add constraint notifications_delivery_channel_check"
        )
      );
    expect(defining.length, "no migration defines the delivery_channel CHECK").toBeGreaterThan(0);

    const inForce = readFileSync(join(dir, defining[defining.length - 1]), "utf8");
    const allowed = [...inForce.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const channel of NODE_CHANNELS) {
      expect(
        allowed,
        `${channel} is missing from the delivery_channel CHECK in ${defining[defining.length - 1]}`
      ).toContain(channel);
    }
  });
});

describe("the Deno reader asks for every preference column it honours", () => {
  /**
   * Every per-channel toggle the Node writer can persist. Derived from the
   * update type rather than hand-listed, so a new channel's column is
   * covered the day it is added rather than the day someone remembers to
   * extend this array.
   *
   * Scoped to the `Pick<>` block specifically, not the whole file. A
   * file-wide scan reads PROSE: the doc comment on `push_urgent` explains
   * why there is deliberately no `push_digest`, and a bare token match turned
   * that sentence into a demand that the digest dispatcher select a column
   * which does not exist. A guard must read the declaration, never the
   * commentary about it.
   */
  const nodeToggles = [
    ...(/export type NotificationPreferencesUpdate = Partial<\s*Pick<[\s\S]*?>\s*>;/
      .exec(NODE_PREFERENCES)?.[0] ?? "").matchAll(/"(\w+_(?:urgent|digest))"/g)
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

describe("both dispatchers actually have a leg for every channel", () => {
  const NODE_DISPATCH = read("src/lib/notifications/dispatch.ts");

  /**
   * Agreeing on the union is not the same as acting on it. A channel declared
   * in both files but wired into only one still means every alert down the
   * other pipeline silently skips it, which looks identical to "that tenant
   * has not connected it".
   */
  it("writes a row for every declared channel, on both sides", () => {
    const nodeLegs = new Set(
      [...NODE_DISPATCH.matchAll(/recordRow\(\s*input\.businessId,\s*"([a-z_]+)"/g)].map(
        (m) => m[1]
      )
    );
    const denoLegs = new Set(
      [
        ...DENO_DISPATCH.matchAll(
          /recordRow\(\s*ctx,\s*record\.business_id,\s*"([a-z_]+)"/g
        )
      ].map((m) => m[1])
    );
    expect(nodeLegs.size, "found no Node legs, so this assertion is vacuous").toBeGreaterThan(1);

    for (const channel of NODE_CHANNELS) {
      expect(nodeLegs.has(channel), `${channel} has no leg in dispatch.ts`).toBe(true);
      expect(
        denoLegs.has(channel),
        `${channel} has no leg in the Deno mirror, so alerts routed through the edge function silently skip it`
      ).toBe(true);
    }
  });

  /**
   * The Deno side cannot do Node crypto, so the channels needing it reach back
   * through an /api/internal route. A renamed or moved route is a 404 that
   * shows up as a bridge failure on every single alert.
   */
  it.each(["slack-send", "whatsapp-send", "push-send", "push-target-state"])(
    "calls /api/internal/%s, and that route exists",
    (bridge) => {
      expect(DENO_DISPATCH).toContain(`/api/internal/${bridge}`);
      expect(() => read(`src/app/api/internal/${bridge}/route.ts`)).not.toThrow();
    }
  );

  /**
   * THE SMS-SUPPRESSION HOLE. Deno used to set pushDeliverable from any live
   * push_subscriptions row (limit 1, no roster check). A leftover HQ view-as
   * device then tripped push_replaces_sms, after which push-send dropped that
   * row and the owner got neither push nor SMS. Eligibility lives in src/lib
   * and cannot be imported here, so the mirror must ask the Node helper.
   *
   * Connected is still derived from a local existence check: a tenant who
   * never subscribed must not collect a phantom skip row when Node is
   * unreachable (worker-integration has no Next app). Deliverable must not
   * follow that same live flag.
   */
  it("does not treat an unfiltered live push row as deliverable", () => {
    expect(DENO_DISPATCH).toContain("/api/internal/push-target-state");
    expect(DENO_DISPATCH).not.toMatch(/pushDeliverable\s*=\s*live/);
    expect(DENO_DISPATCH).not.toMatch(/pushDeliverable\s*=\s*\(pushSubs/);
    expect(DENO_DISPATCH).toMatch(/pushConnected\s*=\s*\(pushSubs/);
  });
});

describe("a push carries the id of the row it is about, on both sides", () => {
  const NODE_DISPATCH = read("src/lib/notifications/dispatch.ts");

  /**
   * Push is the only channel where a tap is a real read receipt, and that
   * rests entirely on one thing: the id the service worker posts back has to
   * name the `notifications` row the push was about. Which means the id must
   * be minted BEFORE the send and reused for the row, in both pipelines.
   *
   * This shipped broken on the Deno side. The edge leg posted no
   * notificationId at all, so a tap on an edge-dispatched alert reported a
   * click bound to nothing: markNotificationRead never fired, the alert
   * stayed unread forever, and the click row landed with a null
   * notification_id. Delivery still worked, the row still said `sent`, and
   * the channel-liveness sweep still counted the tap, so every signal
   * available said the feature was healthy.
   *
   * tests/notifications-dispatch proves the Node half behaviourally. The Deno
   * half cannot be imported here, so this reads the source, which is the same
   * trade the rest of this file makes.
   */

  /** The argument text of a call, scanned with balanced delimiters. */
  function callArgs(source: string, openParenIndex: number): string {
    let depth = 0;
    for (let i = openParenIndex; i < source.length; i += 1) {
      const char = source[i];
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(openParenIndex + 1, i);
      }
    }
    throw new Error("unbalanced call, could not find the closing paren");
  }

  /** The `recordRow(...)` call in this file that writes the SENT push row. */
  function sentPushRecordRowArgs(source: string, label: string): string {
    for (const match of source.matchAll(/recordRow\(/g)) {
      const args = callArgs(source, match.index + "recordRow".length);
      if (/"push"/.test(args) && /"sent"/.test(args)) return args;
    }
    throw new Error(`${label} has no recordRow call writing a sent push row`);
  }

  it.each([
    ["the Node dispatcher", NODE_DISPATCH],
    ["the Deno mirror", DENO_DISPATCH]
  ])("%s sends a notificationId and writes the row under that same id", (label, source) => {
    /**
     * The variable has to be BOTH freshly minted and sent, matched as a pair
     * rather than taken as the first textual hit of either. `notificationId:`
     * alone also matches a type field and the DeliveryResult it builds, and
     * anchoring on those would have made this assertion measure the wrong
     * thing and then fail for the wrong reason.
     */
    const minted = [
      ...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:crypto\.)?randomUUID\(\)/g)
    ].map((m) => m[1]);
    const sent = [...source.matchAll(/notificationId:\s*(\w+)/g)].map((m) => m[1]);
    const idVar = sent.find((name) => minted.includes(name));

    expect(
      idVar,
      `${label} never sends a freshly minted notificationId with its push, so every tap on one of its alerts records a click bound to no row`
    ).toBeTruthy();

    expect(
      sentPushRecordRowArgs(source, label),
      `${label} sends ${idVar} to the push but does not write the notifications row under it, so the receipt names a row that does not exist`
    ).toContain(idVar);
  });
});

describe("both dispatchers raise the admin alarm when a channel fails", () => {
  const NODE_DISPATCH = read("src/lib/notifications/dispatch.ts");

  /**
   * `alert_delivery_failed` is the row that says "a customer may not have
   * heard us", and it is the only thing that turns a failed send into
   * something a human is told about.
   *
   * The edge pipeline had no such alarm at all. It accumulated an `errors`
   * array, returned it in the HTTP response, and dropped it: the caller is
   * pg_net or a VPS script, and nothing reads what it answers. An alert
   * raised through the edge function that failed on EVERY channel told
   * nobody, while its `notifications` rows sat there honestly recording
   * `failed` on a page no one had a reason to open. Every signal available
   * said the alert had been handled.
   */
  it.each([
    ["the Node dispatcher", NODE_DISPATCH],
    ["the Deno mirror", DENO_DISPATCH]
  ])("%s raises alert_delivery_failed from its recorded outcomes", (label, source) => {
    expect(source, `${label} never raises alert_delivery_failed`).toContain(
      'event: "alert_delivery_failed"'
    );

    // Derived from what each leg RECORDED, never from a side list of error
    // strings: those are pushed on transport failures only, so a leg that
    // records a failed row through a structured-outcome branch would be
    // missing from the alarm while present on the card.
    expect(
      source,
      `${label} does not decide the alarm by filtering recorded outcomes on "failed"`
    ).toMatch(/filter\(\([\w.]+\) => [\w.]+\.status === "failed"\)/);

    // Both write the same payload shape, because both land on the same card.
    expect(source).toContain("failedChannels");
    expect(source).toContain("deliveredChannels");

    // Declared AND CALLED. A reporter nothing invokes is the same silence it
    // was written to end.
    //
    // Matched as a call, not as a mention: counting occurrences of the bare
    // name passed even with the call deleted, because the doc comment above
    // it names the function too. A guard that a comment can satisfy is not a
    // guard.
    expect(
      source,
      `${label} declares reportFailedChannels but never calls it`
    ).toMatch(/await reportFailedChannels\(/);
  });
});
