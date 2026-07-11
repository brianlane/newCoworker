import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GEMINI_IMAGE_ASPECT_RATIOS,
  geminiGenerateImage
} from "@/lib/gemini-generate-image";
import { GeminiEmptyError } from "@/lib/gemini-generate-content";

const PNG_BASE64 = Buffer.from("png-bytes").toString("base64");

function okJsonResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json
  } as unknown as Response;
}

function imagePayload(overrides?: {
  mimeType?: string;
  usageMetadata?: Record<string, unknown>;
  extraLeadingPart?: unknown;
}) {
  return {
    candidates: [
      {
        content: {
          parts: [
            ...(overrides?.extraLeadingPart !== undefined ? [overrides.extraLeadingPart] : []),
            {
              inlineData: {
                ...(overrides?.mimeType !== undefined ? { mimeType: overrides.mimeType } : {}),
                data: PNG_BASE64
              }
            }
          ]
        }
      }
    ],
    ...(overrides?.usageMetadata !== undefined ? { usageMetadata: overrides.usageMetadata } : {})
  };
}

describe("geminiGenerateImage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts responseModalities TEXT+IMAGE and decodes the inlineData image", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJsonResponse(
        imagePayload({
          mimeType: "image/png",
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1290, thoughtsTokenCount: 3 }
        })
      )
    );

    const result = await geminiGenerateImage({
      apiKey: "key-1",
      model: " gemini-3.1-flash-lite-image ",
      prompt: "a flyer"
    });

    expect(result.bytes.toString("utf8")).toBe("png-bytes");
    expect(result.mimeType).toBe("image/png");
    expect(result.usage).toEqual({ promptTokens: 12, outputTokens: 1293 });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-image:generateContent",
      expect.objectContaining({ method: "POST" })
    );
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("key-1");
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(body.generationConfig.imageConfig).toBeUndefined();
    expect(body.contents[0].parts[0].text).toBe("a flyer");
  });

  it("sends an input image as an inlineData part (editing mode)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okJsonResponse(imagePayload({ mimeType: "image/png" })));
    await geminiGenerateImage({
      apiKey: "k",
      model: "m",
      prompt: "age this face 20 years",
      inputImage: { bytes: Buffer.from("source-photo"), mimeType: "image/jpeg" }
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.contents[0].parts).toEqual([
      { text: "age this face 20 years" },
      {
        inlineData: {
          mimeType: "image/jpeg",
          data: Buffer.from("source-photo").toString("base64")
        }
      }
    ]);
  });

  it("passes the aspect ratio through imageConfig when set", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(okJsonResponse(imagePayload({ mimeType: "image/webp" })));

    const result = await geminiGenerateImage({
      apiKey: "k",
      model: "gemini-3.1-flash-lite-image",
      prompt: "wide banner",
      aspectRatio: "16:9"
    });

    expect(result.mimeType).toBe("image/webp");
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "16:9" });
  });

  it("exports the supported aspect ratios (1:1 among them)", () => {
    expect(GEMINI_IMAGE_ASPECT_RATIOS).toContain("1:1");
    expect(GEMINI_IMAGE_ASPECT_RATIOS).toContain("16:9");
  });

  it("defaults the MIME type to image/png when the API omits or blanks it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okJsonResponse(imagePayload({ mimeType: "" })));
    const result = await geminiGenerateImage({ apiKey: "k", model: "m", prompt: "p" });
    expect(result.mimeType).toBe("image/png");
  });

  it("skips non-image parts (e.g. a leading text part) to find the inlineData", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJsonResponse(imagePayload({ mimeType: "image/jpeg", extraLeadingPart: { text: "Sure!" } }))
    );
    const result = await geminiGenerateImage({ apiKey: "k", model: "m", prompt: "p" });
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("throws gemini_http_<status> with the body excerpt on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited"
    } as unknown as Response);
    await expect(
      geminiGenerateImage({ apiKey: "k", model: "m", prompt: "p" })
    ).rejects.toThrow("gemini_http_429:rate limited");
  });

  it("tolerates an unreadable error body on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("no body");
      }
    } as unknown as Response);
    await expect(
      geminiGenerateImage({ apiKey: "k", model: "m", prompt: "p" })
    ).rejects.toThrow("gemini_http_500:");
  });

  it("throws gemini_http_parse when the 200 body is not JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      }
    } as unknown as Response);
    await expect(
      geminiGenerateImage({ apiKey: "k", model: "m", prompt: "p" })
    ).rejects.toThrow("gemini_http_parse");
  });

  it("throws GeminiEmptyError carrying billed usage when no image part is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJsonResponse({
        candidates: [{ content: { parts: [{ text: "cannot draw that" }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 21 }
      })
    );
    const err = await geminiGenerateImage({ apiKey: "k", model: "m", prompt: "p" }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(GeminiEmptyError);
    expect((err as GeminiEmptyError).usage).toEqual({ promptTokens: 7, outputTokens: 21 });
  });

  it("throws GeminiEmptyError with null usage on unusable candidate/usage shapes", async () => {
    const shapes: unknown[] = [
      {}, // no candidates
      { candidates: [] }, // empty candidates
      { candidates: [{}] }, // no content
      { candidates: [{ content: {} }] }, // parts not an array
      { candidates: [{ content: { parts: [{ inlineData: { data: "" } }] } }] }, // empty data
      // usageMetadata unusable: non-object, non-finite counts, all-zero counts
      { candidates: [{}], usageMetadata: "nope" },
      { candidates: [{}], usageMetadata: { promptTokenCount: "NaN-ish" } },
      { candidates: [{}], usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } }
    ];
    for (const shape of shapes) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(okJsonResponse(shape));
      const err = await geminiGenerateImage({ apiKey: "k", model: "m", prompt: "p" }).catch(
        (e) => e
      );
      expect(err).toBeInstanceOf(GeminiEmptyError);
      expect((err as GeminiEmptyError).usage).toBeNull();
    }
  });

  it("defaults a missing promptTokenCount to zero when other counts are present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJsonResponse(imagePayload({ usageMetadata: { candidatesTokenCount: 5 } }))
    );
    const result = await geminiGenerateImage({ apiKey: "k", model: "m", prompt: "p" });
    expect(result.usage).toEqual({ promptTokens: 0, outputTokens: 5 });
  });

  it("clamps negative usage token counts to zero", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okJsonResponse(
        imagePayload({
          usageMetadata: { promptTokenCount: -5, candidatesTokenCount: 10, thoughtsTokenCount: -2 }
        })
      )
    );
    const result = await geminiGenerateImage({ apiKey: "k", model: "m", prompt: "p" });
    expect(result.usage).toEqual({ promptTokens: 0, outputTokens: 10 });
  });
});
