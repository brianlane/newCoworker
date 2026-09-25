import { normalizeContactNumber } from "@/lib/telnyx/format";

export type ClinicSheetPatient = {
  firstName: string;
  lastName: string;
  /** E.164, the identity used so a later edit of the same phone is not sent again. */
  phoneE164: string;
  fullName: string;
  /** Empty when the sheet has no Email column or the cell is blank. */
  email: string;
};

export type ParsedClinicSheet =
  | { ok: true; patients: ClinicSheetPatient[] }
  | { ok: false; reason: "missing_name_or_phone_column" };

const COLUMN_G = 6;

function headerKey(cell: string): string {
  return cell.trim().toLowerCase().replace(/[^a-z]/g, "");
}

function findColumn(headers: string[], accept: (key: string) => boolean): number {
  return headers.findIndex((cell) => accept(headerKey(cell)));
}

/**
 * A row is a new patient when it has a first name, a last name, and a phone
 * number. Dane also requires column G to be exactly "10-Day". Incomplete
 * rows are skipped, not an error: a later edit that fills them in can still
 * send. A renamed name or phone header is an error so the caller does not
 * treat the sheet as baselined.
 */
export function parseClinicSheetRows(
  values: string[][],
  options: { require10Day: boolean }
): ParsedClinicSheet {
  const headers = values[0] ?? [];
  const firstCol = findColumn(headers, (key) => key === "firstname" || key === "first");
  const lastCol = findColumn(headers, (key) => key === "lastname" || key === "last");
  const phoneCol = findColumn(
    headers,
    (key) => key.includes("phone") || key === "mobile" || key === "cell"
  );
  const emailCol = findColumn(headers, (key) => key === "email");
  if (firstCol < 0 || lastCol < 0 || phoneCol < 0) {
    return { ok: false, reason: "missing_name_or_phone_column" };
  }

  const patients: ClinicSheetPatient[] = [];
  const seen = new Set<string>();
  for (const row of values.slice(1)) {
    if (options.require10Day && (row[COLUMN_G] ?? "").trim() !== "10-Day") continue;
    const firstName = (row[firstCol] ?? "").trim();
    const lastName = (row[lastCol] ?? "").trim();
    if (!firstName || !lastName) continue;
    const normalized = normalizeContactNumber(row[phoneCol] ?? "");
    if (!normalized.ok || !normalized.value.startsWith("+")) continue;
    if (seen.has(normalized.value)) continue;
    seen.add(normalized.value);
    const email = emailCol < 0 ? "" : (row[emailCol] ?? "").trim();
    patients.push({
      firstName,
      lastName,
      phoneE164: normalized.value,
      fullName: `${firstName} ${lastName}`,
      email: email.includes("@") ? email : ""
    });
  }
  return { ok: true, patients };
}

/** A1 range for a tab title. The title can change; the caller resolved it from the gid. */
export function clinicSheetA1Range(title: string): string {
  return `'${title.replace(/'/g, "''")}'!A:Z`;
}
