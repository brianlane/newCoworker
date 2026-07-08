import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/db/agent-tool-settings", () => ({
  resolveAgentTools: vi.fn(),
  upsertAgentToolSetting: vi.fn()
}));

// Keep the real registry but allow individual tests to stub lookups (the
// live registry has no non-configurable tools anymore, so the 400 branch
// needs a synthetic display-only definition).
vi.mock("@/lib/agent-tools/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-tools/registry")>();
  return { ...actual, findAgentToolDefinition: vi.fn(actual.findAgentToolDefinition) };
});

import { GET, PUT } from "@/app/api/dashboard/agent-tools/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { resolveAgentTools, upsertAgentToolSetting } from "@/lib/db/agent-tool-settings";
import { findAgentToolDefinition } from "@/lib/agent-tools/registry";

const BIZ = "11111111-1111-4111-8111-111111111111";

function getRequest(businessId = BIZ): Request {
  return new Request(`http://localhost/api/dashboard/agent-tools?businessId=${businessId}`);
}

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/dashboard/agent-tools", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({ email: "owner@x.co", isAdmin: false } as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(resolveAgentTools).mockResolvedValue([] as never);
  vi.mocked(upsertAgentToolSetting).mockImplementation(async (args) => ({
    business_id: args.businessId,
    agent_key: args.agentKey,
    tool_key: args.toolKey,
    enabled: args.enabled,
    updated_at: "now"
  }));
});

describe("GET /api/dashboard/agent-tools", () => {
  it("requires auth", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  it("gates on requireBusinessRole for non-admin users", async () => {
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    vi.mocked(requireBusinessRole).mockRejectedValue(err);
    const res = await GET(getRequest());
    expect(res.status).toBe(403);
    expect(vi.mocked(requireBusinessRole)).toHaveBeenCalledWith(BIZ, "manage_settings");
  });

  it("admin bypasses requireBusinessRole", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "admin@x.co", isAdmin: true } as never);
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(vi.mocked(requireBusinessRole)).not.toHaveBeenCalled();
  });

  it("rejects a malformed businessId", async () => {
    const res = await GET(getRequest("not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("returns the resolved agents", async () => {
    vi.mocked(resolveAgentTools).mockResolvedValue([
      { key: "dashboard", label: "Dashboard chat coworker", description: "d", tools: [] }
    ] as never);
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.agents).toHaveLength(1);
    expect(vi.mocked(resolveAgentTools)).toHaveBeenCalledWith(BIZ);
  });
});

describe("PUT /api/dashboard/agent-tools", () => {
  it("requires auth", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await PUT(
      putRequest({ businessId: BIZ, agentKey: "dashboard", toolKey: "send_email", enabled: true })
    );
    expect(res.status).toBe(401);
  });

  it("toggles a configurable tool and echoes the new state", async () => {
    const res = await PUT(
      putRequest({ businessId: BIZ, agentKey: "dashboard", toolKey: "send_email", enabled: true })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ agentKey: "dashboard", toolKey: "send_email", enabled: true });
    expect(vi.mocked(upsertAgentToolSetting)).toHaveBeenCalledWith({
      businessId: BIZ,
      agentKey: "dashboard",
      toolKey: "send_email",
      enabled: true
    });
  });

  it("404s for a tool the registry doesn't know", async () => {
    const res = await PUT(
      putRequest({ businessId: BIZ, agentKey: "dashboard", toolKey: "made_up", enabled: true })
    );
    expect(res.status).toBe(404);
    expect(vi.mocked(upsertAgentToolSetting)).not.toHaveBeenCalled();
  });

  it("400s for non-configurable tools (no platform enforcement point)", async () => {
    vi.mocked(findAgentToolDefinition).mockReturnValueOnce({
      agent: { key: "sms", label: "Texting coworker", description: "t", tools: [] },
      tool: {
        toolKey: "platform_managed_tool",
        label: "Platform-managed tool",
        description: "Display-only.",
        defaultEnabled: true,
        configurable: false
      }
    });
    const res = await PUT(
      putRequest({ businessId: BIZ, agentKey: "sms", toolKey: "platform_managed_tool", enabled: false })
    );
    expect(res.status).toBe(400);
    expect(vi.mocked(upsertAgentToolSetting)).not.toHaveBeenCalled();
  });

  it("400s on a malformed body", async () => {
    const res = await PUT(
      putRequest({ businessId: BIZ, agentKey: "spaceship", toolKey: "send_email", enabled: true })
    );
    expect(res.status).toBe(400);
  });
});
