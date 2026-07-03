import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { generateLoaPdf, type LoaFields } from "@/lib/byon/loa-pdf";

function fields(overrides: Partial<LoaFields> = {}): LoaFields {
  return {
    phoneE164: "+13125550001",
    entityName: "Acme LLC",
    authorizedName: "Jane Doe",
    accountNumber: "ACC-42",
    serviceAddress: {
      street: "311 W Superior St",
      city: "Chicago",
      state: "IL",
      zip: "60654"
    },
    ...overrides
  };
}

describe("generateLoaPdf", () => {
  it("produces a single-page US Letter PDF", async () => {
    const bytes = await generateLoaPdf(fields());
    // %PDF magic header.
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const page = doc.getPage(0);
    expect(page.getWidth()).toBe(612);
    expect(page.getHeight()).toBe(792);
  });

  it("varies with the provided fields (carrier name and extended address included)", async () => {
    const base = await generateLoaPdf(fields());
    const withExtras = await generateLoaPdf(
      fields({
        carrierName: "Old Carrier Inc",
        serviceAddress: {
          street: "311 W Superior St",
          extended: "Suite 400",
          city: "Chicago",
          state: "IL",
          zip: "60654"
        }
      })
    );
    // Extra drawn lines → more content → different (larger) output.
    expect(withExtras.length).not.toBe(base.length);
    const doc = await PDFDocument.load(withExtras);
    expect(doc.getPageCount()).toBe(1);
  });

  it("treats a whitespace-only carrier name and extended address as absent", async () => {
    const blankish = await generateLoaPdf(
      fields({
        carrierName: "  ",
        serviceAddress: {
          street: "311 W Superior St",
          extended: "  ",
          city: "Chicago",
          state: "IL",
          zip: "60654"
        }
      })
    );
    const doc = await PDFDocument.load(blankish);
    expect(doc.getPageCount()).toBe(1);
  });
});
