import { describe, expect, it } from "vitest";
import {
  CHANNEL_DISPLAY_LABELS,
  contactChannelLabel
} from "../src/lib/customer-memory/channel-label";
import type { CustomerMemoryChannel } from "../src/lib/customer-memory/types";

/**
 * The badge on the contact page reads "LAST VIA <channel>", so whatever this
 * returns is what an owner believes happened. The regression it exists for:
 * the public booking page filed its visitors under `webchat` until
 * 20260822160258, which told owners (and the AI preamble) that someone who
 * only filled in a booking form had chatted with the widget.
 */
describe("contactChannelLabel", () => {
  it("spells booking_page as words, never the raw column value", () => {
    expect(contactChannelLabel("booking_page")).toBe("booking page");
  });

  it("passes through the channels that are already single words", () => {
    expect(contactChannelLabel("webchat")).toBe("webchat");
    expect(contactChannelLabel("sms")).toBe("sms");
    expect(contactChannelLabel("voice")).toBe("voice");
    expect(contactChannelLabel("whatsapp")).toBe("whatsapp");
  });

  it("returns null when the contact has never interacted", () => {
    expect(contactChannelLabel(null)).toBeNull();
    expect(contactChannelLabel(undefined)).toBeNull();
  });

  it("treats a blank stored value as no channel", () => {
    expect(contactChannelLabel("")).toBeNull();
    expect(contactChannelLabel("   ")).toBeNull();
  });

  it("trims padding before looking the label up", () => {
    expect(contactChannelLabel("  booking_page  ")).toBe("booking page");
  });

  it("renders an unknown value readably instead of dropping it", () => {
    // A row written by a newer deploy than the one rendering it: better to
    // show a spaced-out label than to silently hide the badge.
    expect(contactChannelLabel("carrier_pigeon")).toBe("carrier pigeon");
    expect(contactChannelLabel("telegram")).toBe("telegram");
  });

  it("never returns an inherited Object.prototype member", () => {
    // A bare index lookup would hand JSX a function for these.
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const label = contactChannelLabel(inherited);
      expect(typeof label, inherited).toBe("string");
    }
    expect(contactChannelLabel("constructor")).toBe("constructor");
  });

  it("labels every channel in the type (the map is total, so this cannot drift)", () => {
    const channels: CustomerMemoryChannel[] = [
      "sms",
      "voice",
      "dashboard",
      "email",
      "webchat",
      "messenger",
      "whatsapp",
      "booking_page"
    ];
    expect(Object.keys(CHANNEL_DISPLAY_LABELS).sort()).toEqual([...channels].sort());
    for (const channel of channels) {
      expect(contactChannelLabel(channel)).toBe(CHANNEL_DISPLAY_LABELS[channel]);
    }
  });

  it("never leaks an underscore to the UI for any known channel", () => {
    for (const label of Object.values(CHANNEL_DISPLAY_LABELS)) {
      expect(label).not.toContain("_");
    }
  });
});
