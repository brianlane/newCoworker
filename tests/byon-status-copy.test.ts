import { describe, expect, it } from "vitest";
import {
  byonCanCancel,
  byonExceptionFixes,
  byonStatusDisplay
} from "@/lib/byon/status-copy";

describe("byonStatusDisplay", () => {
  it("maps every Telnyx status to owner-facing copy", () => {
    expect(byonStatusDisplay("draft")).toMatchObject({ label: "Draft", variant: "neutral" });
    expect(byonStatusDisplay("in-process")).toMatchObject({ variant: "pending" });
    expect(byonStatusDisplay("submitted")).toMatchObject({
      label: "Submitted",
      variant: "pending"
    });
    expect(byonStatusDisplay("exception")).toMatchObject({
      label: "Action needed",
      variant: "error"
    });
    expect(byonStatusDisplay("foc-date-confirmed")).toMatchObject({
      label: "Date confirmed",
      variant: "success"
    });
    expect(byonStatusDisplay("ported")).toMatchObject({ label: "Ported", variant: "success" });
    expect(byonStatusDisplay("cancel-pending")).toMatchObject({ variant: "pending" });
    expect(byonStatusDisplay("cancelled")).toMatchObject({ variant: "neutral" });
    for (const status of [
      "draft",
      "in-process",
      "submitted",
      "exception",
      "foc-date-confirmed",
      "ported",
      "cancel-pending",
      "cancelled"
    ]) {
      expect(byonStatusDisplay(status).line.length).toBeGreaterThan(10);
    }
  });

  it("falls back gracefully for statuses Telnyx adds later", () => {
    const display = byonStatusDisplay("some-new-status");
    expect(display.label).toBe("some-new-status");
    expect(display.variant).toBe("neutral");
    expect(display.line).toContain("tracking");
  });
});

describe("byonExceptionFixes", () => {
  it("returns [] for null or empty details", () => {
    expect(byonExceptionFixes(null)).toEqual([]);
    expect(byonExceptionFixes([])).toEqual([]);
  });

  it("maps every documented exception code to actionable guidance", () => {
    const codes = [
      "ACCOUNT_NUMBER_MISMATCH",
      "AUTH_PERSON_MISMATCH",
      "BTN_ATN_MISMATCH",
      "ENTITY_NAME_MISMATCH",
      "FOC_EXPIRED",
      "FOC_REJECTED",
      "LOCATION_MISMATCH",
      "LSR_PENDING",
      "MAIN_BTN_PORTING",
      "OSP_IRRESPONSIVE",
      "PASSCODE_PIN_INVALID",
      "PHONE_NUMBER_HAS_SPECIAL_FEATURE",
      "PHONE_NUMBER_MISMATCH",
      "PHONE_NUMBER_NOT_PORTABLE",
      "PORT_TYPE_INCORRECT",
      "PORTING_ORDER_SPLIT_REQUIRED",
      "POSTAL_CODE_MISMATCH",
      "RATE_CENTER_NOT_PORTABLE",
      "SV_CONFLICT"
    ];
    for (const code of codes) {
      const fixes = byonExceptionFixes([{ code, description: "raw carrier text" }]);
      expect(fixes).toHaveLength(1);
      // Guidance beats the raw carrier description for known codes.
      expect(fixes[0]).not.toBe("raw carrier text");
      expect(fixes[0].length).toBeGreaterThan(30);
    }
  });

  it("falls back to the Telnyx description for unknown codes, then to generic guidance", () => {
    expect(byonExceptionFixes([{ code: "BRAND_NEW_CODE", description: "carrier said no" }])).toEqual([
      "carrier said no"
    ]);
    expect(byonExceptionFixes([{ code: "BRAND_NEW_CODE" }])).toEqual([
      expect.stringContaining("contact support")
    ]);
    expect(byonExceptionFixes([{ description: "only a description" }])).toEqual([
      "only a description"
    ]);
    expect(byonExceptionFixes([{}])).toEqual([expect.stringContaining("contact support")]);
  });

  it("de-duplicates repeated guidance", () => {
    const fixes = byonExceptionFixes([
      { code: "ACCOUNT_NUMBER_MISMATCH" },
      { code: "ACCOUNT_NUMBER_MISMATCH", description: "dup" }
    ]);
    expect(fixes).toHaveLength(1);
  });
});

describe("byonCanCancel", () => {
  it("allows cancel while the port is still in flight", () => {
    for (const status of ["draft", "in-process", "submitted", "exception", "foc-date-confirmed"]) {
      expect(byonCanCancel(status)).toBe(true);
    }
  });

  it("blocks cancel once terminal or already cancelling", () => {
    for (const status of ["ported", "cancelled", "cancel-pending"]) {
      expect(byonCanCancel(status)).toBe(false);
    }
  });
});
