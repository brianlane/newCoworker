/**
 * Route-aware companion prompt groups: the mapping is total (every path
 * lands somewhere), and every emitted key exists in BOTH message catalogs,
 * so a suggestion can never render as its raw key in either language.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  companionPromptGroupForPath,
  companionPromptKeys,
  type CompanionPromptGroup
} from "@/lib/dashboard-chat/companion-prompts";

const GROUPS: CompanionPromptGroup[] = [
  "default",
  "home",
  "calls",
  "messages",
  "contacts",
  "aiflows",
  "bookings",
  "employees"
];

function catalogCompanion(file: string): Record<string, unknown> {
  const catalog = JSON.parse(readFileSync(join(process.cwd(), "messages", file), "utf8"));
  return catalog.dashboard.companion as Record<string, unknown>;
}

describe("companionPromptGroupForPath", () => {
  it("maps the known dashboard sections, deep paths included", () => {
    expect(companionPromptGroupForPath("/dashboard")).toBe("home");
    expect(companionPromptGroupForPath("/dashboard/")).toBe("home");
    expect(companionPromptGroupForPath("/dashboard/calls")).toBe("calls");
    expect(companionPromptGroupForPath("/dashboard/calls/abc-123")).toBe("calls");
    expect(companionPromptGroupForPath("/dashboard/texts")).toBe("messages");
    expect(companionPromptGroupForPath("/dashboard/messages/thread-1")).toBe("messages");
    expect(companionPromptGroupForPath("/dashboard/webchat/session")).toBe("messages");
    expect(companionPromptGroupForPath("/dashboard/contacts")).toBe("contacts");
    expect(companionPromptGroupForPath("/dashboard/customers/9")).toBe("contacts");
    expect(companionPromptGroupForPath("/dashboard/aiflows/builder")).toBe("aiflows");
    expect(companionPromptGroupForPath("/dashboard/agents")).toBe("aiflows");
    expect(companionPromptGroupForPath("/dashboard/bookings")).toBe("bookings");
    expect(companionPromptGroupForPath("/dashboard/employees")).toBe("employees");
  });

  it("falls back to default for unknown pages, prefix-lookalikes, and query strings", () => {
    expect(companionPromptGroupForPath("/dashboard/settings")).toBe("default");
    expect(companionPromptGroupForPath("/dashboard/callsheet")).toBe("default");
    expect(companionPromptGroupForPath("/dashboard/analytics?range=7d")).toBe("default");
    expect(companionPromptGroupForPath("/dashboard/calls?filter=missed")).toBe("calls");
  });
});

describe("companionPromptKeys", () => {
  it("emits three keys per group and every key exists in en AND es", () => {
    const en = catalogCompanion("en.json");
    const es = catalogCompanion("es.json");
    const prompts = (cat: Record<string, unknown>) => cat.prompts as Record<string, string>;
    for (const group of GROUPS) {
      const keys = companionPromptKeys(group);
      expect(keys).toHaveLength(3);
      for (const key of keys) {
        const leaf = key.replace(/^prompts\./, "");
        expect(
          typeof prompts(en)[leaf],
          `messages/en.json missing dashboard.companion.prompts.${leaf}`
        ).toBe("string");
        expect(
          typeof prompts(es)[leaf],
          `messages/es.json missing dashboard.companion.prompts.${leaf}`
        ).toBe("string");
      }
    }
  });
});
