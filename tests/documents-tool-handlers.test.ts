/**
 * Agent tool cores for Business Documents
 * (src/lib/documents/tool-handlers.ts): list / share / update /
 * set-expiration, with the per-surface gating (dashboard-only mutations,
 * webchat inline-only sharing) and every delivery failure mode.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/db")>()),
  listBusinessDocuments: vi.fn(),
  patchBusinessDocument: vi.fn(),
  revokeDocumentShare: vi.fn()
}));
vi.mock("@/lib/documents/share", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/share")>()),
  mintDocumentShare: vi.fn()
}));
vi.mock("@/lib/documents/ingest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/ingest")>()),
  rewriteDocumentContent: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/logs", () => ({ insertCoworkerLog: vi.fn() }));
vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: vi.fn(),
  sendTelnyxSms: vi.fn()
}));
vi.mock("@/lib/sms/opt-outs", () => ({ checkSmsOptOut: vi.fn() }));
vi.mock("@/lib/email/owner-mailbox", () => ({ sendFromOwnerMailbox: vi.fn() }));
vi.mock("@/lib/db/email-log", () => ({ recordOutboundAssistantEmail: vi.fn() }));
vi.mock("@/lib/vps/sync-vault", () => ({ syncVaultToVpsAndLog: vi.fn(async () => {}) }));

import {
  listDocumentsTool,
  setDocumentExpirationTool,
  shareDocumentTool,
  updateDocumentTool
} from "@/lib/documents/tool-handlers";
import {
  listBusinessDocuments,
  patchBusinessDocument,
  revokeDocumentShare,
  type BusinessDocumentRow
} from "@/lib/documents/db";
import { mintDocumentShare } from "@/lib/documents/share";
import { rewriteDocumentContent } from "@/lib/documents/ingest";
import { getBusiness } from "@/lib/db/businesses";
import { insertCoworkerLog } from "@/lib/db/logs";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { sendFromOwnerMailbox } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15551230000";

function doc(overrides: Partial<BusinessDocumentRow> = {}): BusinessDocumentRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    business_id: BIZ,
    title: "Price sheet",
    category: "pricing",
    audience: "both",
    storage_path: "p/price.pdf",
    mime_type: "application/pdf",
    byte_size: 10,
    content_md: "- Haircut: $40",
    summary: "Prices.",
    status: "ready",
    error_detail: null,
    expires_at: null,
    expiring_soon_notified_at: null,
    expired_notified_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

const list = vi.mocked(listBusinessDocuments);
const patch = vi.mocked(patchBusinessDocument);
const mint = vi.mocked(mintDocumentShare);
const rewrite = vi.mocked(rewriteDocumentContent);
const optOut = vi.mocked(checkSmsOptOut);
const smsConfig = vi.mocked(getTelnyxMessagingForBusiness);
const smsSend = vi.mocked(sendTelnyxSms);
const emailSend = vi.mocked(sendFromOwnerMailbox);

const MINTED = {
  ok: true as const,
  shareId: "share-1",
  url: "https://app.example.com/api/public/docs/tok123",
  expiresAt: "2026-08-10T12:00:00.000Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([doc()]);
  patch.mockResolvedValue(undefined);
  mint.mockResolvedValue(MINTED);
  vi.mocked(getBusiness).mockResolvedValue({ name: "Clip Joint" } as never);
  vi.mocked(insertCoworkerLog).mockResolvedValue({} as never);
  optOut.mockResolvedValue({ ok: true, optedOut: false });
  vi.mocked(revokeDocumentShare).mockResolvedValue(undefined);
  smsConfig.mockResolvedValue({ apiKey: "k" } as never);
  smsSend.mockResolvedValue({ id: "msg-1" } as never);
  emailSend.mockResolvedValue({ ok: true, messageId: "em-1", provider: "google" } as never);
  vi.mocked(recordOutboundAssistantEmail).mockResolvedValue(undefined);
});

describe("listDocumentsTool", () => {
  it("returns the metadata view", async () => {
    const res = await listDocumentsTool(BIZ);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({
      documents: [
        {
          id: doc().id,
          title: "Price sheet",
          category: "pricing",
          audience: "both",
          status: "ready",
          expiresAt: null,
          summary: "Prices."
        }
      ]
    });
  });
});

describe("shareDocumentTool", () => {
  it("fails with guidance when the document is not found", async () => {
    const res = await shareDocumentTool(BIZ, { documentRef: "warranty" }, "sms");
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("document_not_found");
    expect(res.message).toContain("Never invent a link");
  });

  it("fails with guidance on an ambiguous reference", async () => {
    list.mockResolvedValue([doc({ id: "a", title: "Menu A" }), doc({ id: "b", title: "Menu B" })]);
    const res = await shareDocumentTool(BIZ, { documentRef: "menu" }, "sms");
    expect(res).toMatchObject({ ok: false, detail: "document_ambiguous" });
  });

  it("maps every mint refusal to model guidance", async () => {
    for (const [detail, needle] of [
      ["document_expired", "expired"],
      ["document_not_shareable", "internal-only"],
      ["document_not_ready", "not ready"]
    ] as const) {
      mint.mockResolvedValue({ ok: false, detail });
      const res = await shareDocumentTool(BIZ, { documentRef: "price" }, "sms");
      expect(res.detail).toBe(detail);
      expect(res.message).toContain(needle);
    }
  });

  it("texts the link with a default intro and logs the share", async () => {
    const res = await shareDocumentTool(BIZ, { documentRef: "price", phone: PHONE }, "sms");
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ delivered: "sms", url: MINTED.url });
    expect(smsSend).toHaveBeenCalledWith(
      expect.anything(),
      PHONE,
      `Here is "Price sheet" from Clip Joint: ${MINTED.url}`,
      { meterBusinessId: BIZ }
    );
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        task_type: "sms",
        status: "success",
        log_payload: expect.objectContaining({ event: "document_shared", delivered: "sms" })
      })
    );
  });

  it("keeps a custom message that already contains the link", async () => {
    await shareDocumentTool(
      BIZ,
      { documentRef: "price", phone: PHONE, message: `Check ${MINTED.url} now` },
      "voice"
    );
    expect(smsSend).toHaveBeenCalledWith(
      expect.anything(),
      PHONE,
      `Check ${MINTED.url} now`,
      expect.anything()
    );
  });

  it("omits the business name when the row is missing", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    await shareDocumentTool(BIZ, { documentRef: "price", phone: PHONE }, "sms");
    expect(smsSend).toHaveBeenCalledWith(
      expect.anything(),
      PHONE,
      `Here is "Price sheet": ${MINTED.url}`,
      expect.anything()
    );
  });

  it("fails closed when the opt-out check errors — BEFORE any link is minted", async () => {
    optOut.mockResolvedValue({ ok: false, error: "rpc down" });
    const res = await shareDocumentTool(BIZ, { documentRef: "price", phone: PHONE }, "sms");
    expect(res).toEqual({ ok: false, detail: "opt_out_check_failed" });
    expect(smsSend).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it("refuses an opted-out recipient without minting a link", async () => {
    optOut.mockResolvedValue({ ok: true, optedOut: true });
    const res = await shareDocumentTool(BIZ, { documentRef: "price", phone: PHONE }, "sms");
    expect(res).toEqual({ ok: false, detail: "recipient_opted_out" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("maps quota errors and generic send failures distinctly, revoking the undelivered link", async () => {
    smsSend.mockRejectedValueOnce(new Error("Monthly SMS limit reached"));
    expect(
      (await shareDocumentTool(BIZ, { documentRef: "price", phone: PHONE }, "sms")).detail
    ).toBe("sms_quota_blocked");
    smsSend.mockRejectedValueOnce("wire down");
    expect(
      (await shareDocumentTool(BIZ, { documentRef: "price", phone: PHONE }, "sms")).detail
    ).toBe("sms_send_failed");
    expect(revokeDocumentShare).toHaveBeenCalledTimes(2);
    expect(revokeDocumentShare).toHaveBeenCalledWith(BIZ, MINTED.shareId);
  });

  it("tolerates a failing revoke on an undelivered share (link still dies at TTL)", async () => {
    smsSend.mockRejectedValueOnce(new Error("wire down"));
    vi.mocked(revokeDocumentShare).mockRejectedValueOnce(new Error("db down"));
    const res = await shareDocumentTool(BIZ, { documentRef: "price", phone: PHONE }, "sms");
    expect(res).toEqual({ ok: false, detail: "sms_send_failed" });
    smsSend.mockRejectedValueOnce(new Error("wire down"));
    vi.mocked(revokeDocumentShare).mockRejectedValueOnce("string failure");
    const res2 = await shareDocumentTool(BIZ, { documentRef: "price", phone: PHONE }, "sms");
    expect(res2.ok).toBe(false);
  });

  it("emails the link when an email is given", async () => {
    const res = await shareDocumentTool(
      BIZ,
      { documentRef: "price", email: "lead@example.com" },
      "dashboard"
    );
    expect(res.data).toMatchObject({ delivered: "email" });
    expect(emailSend).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({
        toEmail: "lead@example.com",
        subject: "Document: Price sheet",
        bodyText: expect.stringContaining(MINTED.url)
      })
    );
    expect(recordOutboundAssistantEmail).toHaveBeenCalledWith(
      expect.objectContaining({ source: "dashboard_chat" })
    );
  });

  it("omits the business name in the default email body when the row is missing", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    await shareDocumentTool(BIZ, { documentRef: "price", email: "l@example.com" }, "dashboard");
    expect(emailSend).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ bodyText: expect.stringContaining('Here is "Price sheet".') })
    );
  });

  it("uses the custom message in the email body", async () => {
    await shareDocumentTool(
      BIZ,
      { documentRef: "price", email: "l@example.com", message: "As promised." },
      "dashboard"
    );
    expect(emailSend).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ bodyText: expect.stringContaining("As promised.") })
    );
  });

  it("propagates email failures and revokes the undelivered link", async () => {
    emailSend.mockResolvedValue({ ok: false, detail: "email_not_connected" } as never);
    const res = await shareDocumentTool(
      BIZ,
      { documentRef: "price", email: "l@example.com" },
      "dashboard"
    );
    expect(res).toEqual({ ok: false, detail: "email_not_connected" });
    expect(revokeDocumentShare).toHaveBeenCalledWith(BIZ, MINTED.shareId);
  });

  it("returns the link inline for the dashboard with no recipient", async () => {
    const res = await shareDocumentTool(BIZ, { documentRef: "price" }, "dashboard");
    expect(res.data).toMatchObject({ delivered: "inline" });
    expect(res.message).toContain("Share this link");
    expect(smsSend).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("webchat is ALWAYS inline — no sends even when a phone is supplied", async () => {
    const res = await shareDocumentTool(BIZ, { documentRef: "price", phone: PHONE }, "webchat");
    expect(res.data).toMatchObject({ delivered: "inline" });
    expect(smsSend).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ channel: "webchat" }));
  });

  it("labels a webchat share without args as a webchat visitor", async () => {
    await shareDocumentTool(BIZ, { documentRef: "price" }, "webchat");
    expect(mint).toHaveBeenCalledWith(expect.objectContaining({ sharedWith: "webchat visitor" }));
  });
});

describe("updateDocumentTool", () => {
  const args = { documentRef: "price", instruction: "haircuts are now $45" };

  it("hard-refuses every non-dashboard surface", async () => {
    for (const surface of ["sms", "voice", "webchat"] as const) {
      expect(await updateDocumentTool(BIZ, args, surface)).toEqual({
        ok: false,
        detail: "surface_not_allowed"
      });
    }
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("fails on an unknown document", async () => {
    const res = await updateDocumentTool(BIZ, { ...args, documentRef: "nope" }, "dashboard");
    expect(res.detail).toBe("document_not_found");
  });

  it("refuses a document with no extracted content", async () => {
    list.mockResolvedValue([doc({ content_md: "   " })]);
    const res = await updateDocumentTool(BIZ, args, "dashboard");
    expect(res).toEqual({ ok: false, detail: "document_empty" });
  });

  it("propagates rewrite failures", async () => {
    rewrite.mockResolvedValue({ ok: false, error: "summarizer_failed", detail: "boom" });
    const res = await updateDocumentTool(BIZ, args, "dashboard");
    expect(res).toEqual({ ok: false, detail: "summarizer_failed" });
  });

  it("refuses an empty rewrite result (never wipes a document)", async () => {
    rewrite.mockResolvedValue({ ok: true, contentMd: "  ", summary: "s" });
    const res = await updateDocumentTool(BIZ, args, "dashboard");
    expect(res).toEqual({ ok: false, detail: "rewrite_empty" });
    expect(patch).not.toHaveBeenCalled();
  });

  it("patches content, keeps the old summary when the rewrite has none, logs, and re-syncs", async () => {
    rewrite.mockResolvedValue({ ok: true, contentMd: "- Haircut: $45", summary: "" });
    const res = await updateDocumentTool(BIZ, args, "dashboard");
    expect(res.ok).toBe(true);
    expect(patch).toHaveBeenCalledWith(BIZ, doc().id, {
      content_md: "- Haircut: $45",
      summary: "Prices."
    });
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: "data_flow",
        status: "success",
        log_payload: expect.objectContaining({ event: "document_updated" })
      })
    );
    expect(syncVaultToVpsAndLog).toHaveBeenCalledWith(BIZ);
  });

  it("uses the fresh summary when the rewrite provides one", async () => {
    rewrite.mockResolvedValue({ ok: true, contentMd: "- Haircut: $45", summary: "New prices." });
    await updateDocumentTool(BIZ, args, "dashboard");
    expect(patch).toHaveBeenCalledWith(BIZ, doc().id, expect.objectContaining({ summary: "New prices." }));
  });
});

describe("setDocumentExpirationTool", () => {
  it("hard-refuses non-dashboard surfaces", async () => {
    const res = await setDocumentExpirationTool(
      BIZ,
      { documentRef: "price", expiresAt: "2026-08-01" },
      "sms"
    );
    expect(res).toEqual({ ok: false, detail: "surface_not_allowed" });
  });

  it("fails on an unknown document", async () => {
    const res = await setDocumentExpirationTool(
      BIZ,
      { documentRef: "nope", expiresAt: null },
      "dashboard"
    );
    expect(res.detail).toBe("document_not_found");
  });

  it("rejects an unparseable date", async () => {
    const res = await setDocumentExpirationTool(
      BIZ,
      { documentRef: "price", expiresAt: "next Tuesday-ish" },
      "dashboard"
    );
    expect(res).toEqual({ ok: false, detail: "invalid_date" });
  });

  it("sets the date, re-arms the sweep stamps, logs, and re-syncs", async () => {
    const res = await setDocumentExpirationTool(
      BIZ,
      { documentRef: "price", expiresAt: "2026-08-01T00:00:00Z" },
      "dashboard"
    );
    expect(res.ok).toBe(true);
    expect(res.message).toContain("expires 2026-08-01");
    expect(patch).toHaveBeenCalledWith(BIZ, doc().id, {
      expires_at: "2026-08-01T00:00:00.000Z",
      expiring_soon_notified_at: null,
      expired_notified_at: null
    });
    expect(insertCoworkerLog).toHaveBeenCalledWith(
      expect.objectContaining({
        task_type: "data_flow",
        status: "success",
        log_payload: expect.objectContaining({ event: "document_expiration_set" })
      })
    );
    expect(syncVaultToVpsAndLog).toHaveBeenCalledWith(BIZ);
  });

  it("reports reactivation when extending an already-expired document", async () => {
    list.mockResolvedValue([doc({ expires_at: "2020-01-01T00:00:00Z" })]);
    const res = await setDocumentExpirationTool(
      BIZ,
      { documentRef: "price", expiresAt: "2999-01-01" },
      "dashboard"
    );
    expect(res.message).toContain("active again");
  });

  it("clears the expiration with null or an empty string", async () => {
    const res = await setDocumentExpirationTool(
      BIZ,
      { documentRef: "price", expiresAt: null },
      "dashboard"
    );
    expect(res.message).toContain("no longer expires");
    expect(patch).toHaveBeenCalledWith(BIZ, doc().id, expect.objectContaining({ expires_at: null }));
    const res2 = await setDocumentExpirationTool(
      BIZ,
      { documentRef: "price", expiresAt: "  " },
      "dashboard"
    );
    expect(res2.ok).toBe(true);
  });
});
