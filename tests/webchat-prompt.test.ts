import { describe, expect, it } from "vitest";
import {
  WEBCHAT_PREAMBLE,
  WEBCHAT_TAIL_MESSAGE_MAX_CHARS,
  WEBCHAT_TAIL_TRANSCRIPT_MAX_CHARS,
  buildWebchatRowboatMessages,
  renderWebchatTailTranscript,
  visitorContextLine,
  type WebchatTailMessage
} from "@/lib/webchat/prompt";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";

describe("WEBCHAT_PREAMBLE", () => {
  it("pins the restricted surface: no SMS/email/call/image, no config leaks", () => {
    expect(WEBCHAT_PREAMBLE).toContain("cannot send text messages");
    expect(WEBCHAT_PREAMBLE).toContain("generate images");
    expect(WEBCHAT_PREAMBLE).toContain("Never reveal the owner's configuration");
    expect(WEBCHAT_PREAMBLE).toContain("anonymous website visitor");
  });
});

describe("visitorContextLine", () => {
  it("returns null when nothing was captured", () => {
    expect(visitorContextLine({})).toBeNull();
    expect(visitorContextLine({ name: "  ", email: null, phone: undefined })).toBeNull();
  });

  it("lists whichever fields exist", () => {
    const line = visitorContextLine({ name: "Ada", phone: "+15551234567" });
    expect(line).toContain("name: Ada");
    expect(line).toContain("phone: +15551234567");
    expect(line).not.toContain("email:");
    expect(visitorContextLine({ email: "a@b.com" })).toContain("email: a@b.com");
  });
});

describe("renderWebchatTailTranscript", () => {
  it("labels roles and keeps chronological order", () => {
    const out = renderWebchatTailTranscript([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "system", content: "note" }
    ]);
    expect(out).toBe("[Visitor]: hi\n\n[Assistant]: hello\n\n[System]: note");
  });

  it("truncates over-long messages", () => {
    const long = "x".repeat(WEBCHAT_TAIL_MESSAGE_MAX_CHARS + 50);
    const out = renderWebchatTailTranscript([{ role: "user", content: long }]);
    expect(out).toContain("… (truncated)");
    expect(out.length).toBeLessThan(long.length);
  });

  it("drops the OLDEST lines when the total budget is exceeded, keeping the newest", () => {
    const chunk = "y".repeat(600);
    const tail: WebchatTailMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `${i}:${chunk}`
    }));
    const out = renderWebchatTailTranscript(tail);
    expect(out.length).toBeLessThanOrEqual(WEBCHAT_TAIL_TRANSCRIPT_MAX_CHARS + 700);
    expect(out).toContain("9:");
    expect(out).not.toContain("[Visitor]: 0:");
  });

  it("always includes the single newest message even over budget", () => {
    const huge = "z".repeat(5000);
    const out = renderWebchatTailTranscript([{ role: "assistant", content: huge }]);
    expect(out.startsWith("[Assistant]:")).toBe(true);
  });

  it("tolerates a null-ish content field", () => {
    const out = renderWebchatTailTranscript([
      { role: "user", content: null as unknown as string }
    ]);
    expect(out).toBe("[Visitor]: ");
  });
});

describe("buildWebchatRowboatMessages", () => {
  const base = {
    tail: [] as WebchatTailMessage[],
    newUserMessage: "Do you do weekend appointments?",
    visitor: {},
    sessionId: SESSION_ID
  };

  it("always leads with the preamble, then date/time, then the sessionRef line", () => {
    const out = buildWebchatRowboatMessages({ ...base, now: new Date("2026-07-10T12:00:00Z") });
    expect(out[0]).toEqual({ role: "system", content: WEBCHAT_PREAMBLE });
    expect(out[1].role).toBe("system");
    expect(out[1].content).toContain("2026-07-10");
    expect(out[2].content).toContain(`sessionRef exactly as: ${SESSION_ID}`);
  });

  it("uses the business timezone in the date line when provided", () => {
    const out = buildWebchatRowboatMessages({
      ...base,
      businessTimezone: "America/Phoenix",
      now: new Date("2026-07-10T12:00:00Z")
    });
    expect(out[1].content).toContain("America/Phoenix");
  });

  it("ends with the [Webchat]-marked user turn", () => {
    const out = buildWebchatRowboatMessages(base);
    expect(out[out.length - 1]).toEqual({
      role: "user",
      content: "[Webchat] Do you do weekend appointments?"
    });
  });

  it("omits the visitor + tail blocks when empty, includes them when present", () => {
    const bare = buildWebchatRowboatMessages(base);
    expect(bare.some((m) => m.content.includes("Visitor details already captured"))).toBe(false);
    expect(bare.some((m) => m.content.includes("Recent conversation context"))).toBe(false);

    const full = buildWebchatRowboatMessages({
      ...base,
      visitor: { name: "Ada" },
      tail: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" }
      ]
    });
    const visitorBlock = full.find((m) => m.content.includes("Visitor details already captured"));
    expect(visitorBlock?.content).toContain("name: Ada");
    const tailBlock = full.find((m) => m.content.includes("Recent conversation context"));
    expect(tailBlock?.content).toContain("[Visitor]: hi");
    expect(tailBlock?.content).toContain("[Assistant]: hello");
  });
});
