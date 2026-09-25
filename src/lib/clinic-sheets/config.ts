/**
 * BA Fitness clinic sheets the reader polls. Tab identity is the spreadsheet
 * id plus the sheet gid (the number in the URL), so renaming a tab does not
 * break the read. A new spreadsheet id, or a renamed name or phone header,
 * does.
 *
 * Clinic name is added here. The sheets do not have that column.
 */
export const CLINIC_SHEETS_BUSINESS_ID = "d2d421a8-47ef-4a1d-b8af-7e86a02a95f1";

export const CLINIC_SHEETS_SOURCE = "clinic_google_sheet";

export type ClinicSheetTarget = {
  spreadsheetId: string;
  /** Google sheet id (gid in the URL), not the tab title. */
  sheetGid: number;
  clinicName: string;
  /** Dane only: send the row when column G is exactly "10-Day". */
  require10Day: boolean;
};

export const CLINIC_SHEET_TARGETS: readonly ClinicSheetTarget[] = [
  {
    spreadsheetId: "1Tkrjlaw9ja-q8d9POQjft1gqVDMsjj-b6IQqnqLJnSI",
    sheetGid: 660314714,
    clinicName: "New Jersey Weight Loss Company",
    require10Day: false
  },
  {
    spreadsheetId: "1_9n-2eJeK6wLQ_KNa4k427SxJUaZhsbkY5cjTPPime8",
    sheetGid: 38901107,
    clinicName: "Eros Vitality",
    require10Day: false
  },
  {
    spreadsheetId: "1vq2cHQnbVWmS1vyuTi6SJRBctBbyFEO1BzXLZm1QyAA",
    sheetGid: 38901107,
    clinicName: "Dane Functional Health",
    require10Day: true
  }
];
