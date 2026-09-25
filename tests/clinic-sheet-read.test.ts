import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { clinicSheetsKeyFromEnv, readClinicSheetTab } from "@/lib/clinic-sheets/read";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY = {
  client_email: "clinic-sheets@new-coworker.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  project_id: "new-coworker"
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("clinicSheetsKeyFromEnv", () => {
  it("returns null for a missing or unusable key", () => {
    expect(clinicSheetsKeyFromEnv(null)).toBeNull();
    expect(clinicSheetsKeyFromEnv("")).toBeNull();
    expect(clinicSheetsKeyFromEnv("not-json")).toBeNull();
  });

  it("returns the service account fields", () => {
    expect(clinicSheetsKeyFromEnv(JSON.stringify(KEY))?.client_email).toBe(KEY.client_email);
  });
});

describe("readClinicSheetTab", () => {
  it("returns the grid for the gid, including a renamed tab", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("oauth2.googleapis.com")) {
        return jsonResponse({ access_token: "tok" });
      }
      if (url.includes("/values/")) {
        return jsonResponse({ values: [["First Name"], ["Ada", null]] });
      }
      return jsonResponse({
        sheets: [{ properties: { sheetId: 660314714, title: "Zapier_data renamed" } }]
      });
    }) as typeof fetch;

    const read = await readClinicSheetTab({
      key: KEY,
      spreadsheetId: "sheet-1",
      sheetGid: 660314714,
      fetchImpl,
      nowMs: 1_700_000_000_000
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.grid.title).toBe("Zapier_data renamed");
    expect(read.grid.values).toEqual([
      ["First Name"],
      ["Ada", ""]
    ]);
    expect(urls.some((url) => url.includes("Zapier_data%20renamed"))).toBe(true);
  });

  it("uses the global fetch when none is injected", async () => {
    const fetchImpl = vi.fn(async () => {
      throw "default fetch";
    });
    vi.stubGlobal("fetch", fetchImpl);
    const read = await readClinicSheetTab({
      key: KEY,
      spreadsheetId: "sheet-1",
      sheetGid: 1
    });
    expect(read).toMatchObject({ ok: false, status: 0, detail: "default fetch" });
    expect(fetchImpl).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports a token exchange failure that is not an Error", async () => {
    const fetchImpl = (async () => {
      throw "token down";
    }) as typeof fetch;
    const read = await readClinicSheetTab({
      key: KEY,
      spreadsheetId: "sheet-1",
      sheetGid: 1,
      fetchImpl
    });
    expect(read).toMatchObject({ ok: false, status: 0, detail: "token down" });
  });

  it("reports a token exchange failure", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const read = await readClinicSheetTab({
      key: KEY,
      spreadsheetId: "sheet-1",
      sheetGid: 1,
      fetchImpl,
      nowMs: 1_700_000_000_000
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.status).toBe(0);
    expect(read.detail).toContain("401");
  });

  it("reports a metadata failure, including a removed share", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) return jsonResponse({ access_token: "tok" });
      return new Response("The caller does not have permission", { status: 403 });
    }) as typeof fetch;
    const read = await readClinicSheetTab({
      key: KEY,
      spreadsheetId: "sheet-1",
      sheetGid: 1,
      fetchImpl
    });
    expect(read).toMatchObject({ ok: false, status: 403 });
  });

  it("reports a missing gid", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) return jsonResponse({ access_token: "tok" });
      return jsonResponse({ sheets: [{ properties: { sheetId: 9, title: "Other" } }] });
    }) as typeof fetch;
    const read = await readClinicSheetTab({
      key: KEY,
      spreadsheetId: "sheet-1",
      sheetGid: 1,
      fetchImpl
    });
    expect(read).toEqual({ ok: false, status: 404, detail: "sheet gid not found" });
  });

  it("reports a values read failure", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) return jsonResponse({ access_token: "tok" });
      if (url.includes("/values/")) return new Response("boom", { status: 500 });
      return jsonResponse({ sheets: [{ properties: { sheetId: 1, title: "Tab" } }] });
    }) as typeof fetch;
    const read = await readClinicSheetTab({
      key: KEY,
      spreadsheetId: "sheet-1",
      sheetGid: 1,
      fetchImpl
    });
    expect(read).toMatchObject({ ok: false, status: 500, detail: "boom" });
  });

  it("treats a sheet with no value rows as an empty grid", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) return jsonResponse({ access_token: "tok" });
      if (url.includes("/values/")) return jsonResponse({});
      return jsonResponse({ sheets: [{ properties: { sheetId: 1, title: "Tab" } }] });
    }) as typeof fetch;
    const read = await readClinicSheetTab({
      key: KEY,
      spreadsheetId: "sheet-1",
      sheetGid: 1,
      fetchImpl
    });
    expect(read).toEqual({ ok: true, grid: { title: "Tab", values: [] } });
  });
});
