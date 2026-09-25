import {
  fetchGoogleAccessToken,
  parseGcpServiceAccountKey,
  type GcpServiceAccountKey
} from "@/lib/google/bigquery";
import { clinicSheetA1Range } from "@/lib/clinic-sheets/rows";

const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

type SheetGrid = {
  title: string;
  values: string[][];
};

export type SheetReadResult =
  | { ok: true; grid: SheetGrid }
  | { ok: false; status: number; detail: string };

type FetchImpl = typeof fetch;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Read one tab by gid. A renamed tab still matches, because the gid does not
 * change when the title does. A missing gid, or a 403 after the robot is
 * removed from the share, comes back as a failed read.
 */
export async function readClinicSheetTab(params: {
  key: GcpServiceAccountKey;
  spreadsheetId: string;
  sheetGid: number;
  fetchImpl?: FetchImpl;
  nowMs?: number;
}): Promise<SheetReadResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  let token: string;
  try {
    token = await fetchGoogleAccessToken({
      key: params.key,
      scope: SHEETS_READONLY_SCOPE,
      fetchImpl,
      nowMs: params.nowMs
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : String(err)
    };
  }

  const metaUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(params.spreadsheetId)}` +
    "?fields=sheets.properties(sheetId,title)";
  const metaRes = await fetchImpl(metaUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!metaRes.ok) {
    const body = (await metaRes.text()).slice(0, 300);
    return { ok: false, status: metaRes.status, detail: body };
  }
  const meta = (await metaRes.json()) as {
    sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
  };
  const title = meta.sheets?.find((sheet) => sheet.properties?.sheetId === params.sheetGid)
    ?.properties?.title;
  if (!title) {
    return { ok: false, status: 404, detail: "sheet gid not found" };
  }

  const range = encodeURIComponent(clinicSheetA1Range(title));
  const valuesUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(params.spreadsheetId)}` +
    `/values/${range}`;
  const valuesRes = await fetchImpl(valuesUrl, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!valuesRes.ok) {
    const body = (await valuesRes.text()).slice(0, 300);
    return { ok: false, status: valuesRes.status, detail: body };
  }
  const valuesBody = (await valuesRes.json()) as { values?: unknown[][] };
  const values = (valuesBody.values ?? []).map((row) => row.map(cellText));
  return { ok: true, grid: { title, values } };
}

export function clinicSheetsKeyFromEnv(raw: string | null | undefined): GcpServiceAccountKey | null {
  return parseGcpServiceAccountKey(raw);
}
