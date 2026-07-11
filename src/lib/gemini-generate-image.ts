/**
 * Gemini Developer API (`ai.google.dev` key): native image generation via
 * `generateContent` with `responseModalities: ["TEXT","IMAGE"]`.
 *
 * Sibling of gemini-generate-content.ts (same endpoint family, same error
 * vocabulary) but returns the candidate's `inlineData` image part instead of
 * text. The default deployment model is `gemini-3.1-flash-lite-image`
 * (fastest/cheapest image tier, 1K only); callers pass the model explicitly
 * so surfaces can override via env.
 *
 * @see https://ai.google.dev/gemini-api/docs/image-generation
 */

import { GeminiEmptyError, type GeminiUsage } from "@/lib/gemini-generate-content";

/** Aspect ratios accepted by the image models (1K resolution tier). */
export const GEMINI_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9"
] as const;

export type GeminiImageAspectRatio = (typeof GEMINI_IMAGE_ASPECT_RATIOS)[number];

export type GeminiInputImage = {
  bytes: Buffer;
  /** e.g. `image/jpeg` — must be an image type the API accepts. */
  mimeType: string;
};

export type GeminiGenerateImageParams = {
  apiKey: string;
  /** Short model id, e.g. `gemini-3.1-flash-lite-image` (no `models/` prefix). */
  model: string;
  /** The image description (or the edit instruction when `inputImage` is set). */
  prompt: string;
  /**
   * Optional source image for editing/reference generation: sent as an
   * `inlineData` part alongside the prompt, so "age this face 20 years" or
   * "put this product on a beach" edits the supplied photo instead of
   * generating from scratch.
   */
  inputImage?: GeminiInputImage;
  /** Optional aspect ratio; omitted ⇒ the model default (1:1). */
  aspectRatio?: GeminiImageAspectRatio;
  signal?: AbortSignal;
};

export type GeminiGenerateImageResult = {
  /** Raw image bytes decoded from the inlineData base64 payload. */
  bytes: Buffer;
  /** Image MIME type as reported by the API (e.g. `image/png`). */
  mimeType: string;
  /** Null when the response carried no parseable usageMetadata. */
  usage: GeminiUsage | null;
};

/** Mirror of gemini-generate-content's usage extraction (kept private there). */
function extractUsage(json: unknown): GeminiUsage | null {
  const meta = (json as { usageMetadata?: Record<string, unknown> })?.usageMetadata;
  if (!meta || typeof meta !== "object") return null;
  const prompt = Number(meta["promptTokenCount"] ?? 0);
  const candidates = Number(meta["candidatesTokenCount"] ?? 0);
  const thoughts = Number(meta["thoughtsTokenCount"] ?? 0);
  if (!Number.isFinite(prompt) || !Number.isFinite(candidates) || !Number.isFinite(thoughts)) {
    return null;
  }
  const promptTokens = Math.max(0, prompt);
  const outputTokens = Math.max(0, candidates) + Math.max(0, thoughts);
  if (promptTokens === 0 && outputTokens === 0) return null;
  return { promptTokens, outputTokens };
}

type InlinePart = { inlineData?: { mimeType?: string; data?: string } };

function extractInlineImage(json: unknown): { mimeType: string; data: string } | null {
  const root = json as Record<string, unknown>;
  const candidates = root?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0] as Record<string, unknown> | undefined;
  const content = first?.content as Record<string, unknown> | undefined;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts as InlinePart[]) {
    const inline = part?.inlineData;
    if (inline && typeof inline.data === "string" && inline.data.length > 0) {
      return {
        mimeType:
          typeof inline.mimeType === "string" && inline.mimeType.length > 0
            ? inline.mimeType
            : "image/png",
        data: inline.data
      };
    }
  }
  return null;
}

/**
 * One-shot image generation via `models/{model}:generateContent`.
 * @throws Error `gemini_http_<status>:...` on non-OK HTTP
 * @throws Error `gemini_http_parse` when the body is not JSON
 * @throws GeminiEmptyError when the response parses but carries no image part
 *   (Google still bills these calls — the error carries usage for metering)
 */
export async function geminiGenerateImage(
  params: GeminiGenerateImageParams
): Promise<GeminiGenerateImageResult> {
  const model = encodeURIComponent(params.model.trim());
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": params.apiKey
    },
    signal: params.signal,
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: params.prompt },
            // Editing/reference mode: the source photo rides alongside the
            // instruction as inline data (nano-banana image editing).
            ...(params.inputImage
              ? [
                  {
                    inlineData: {
                      mimeType: params.inputImage.mimeType,
                      data: params.inputImage.bytes.toString("base64")
                    }
                  }
                ]
              : [])
          ]
        }
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(params.aspectRatio ? { imageConfig: { aspectRatio: params.aspectRatio } } : {})
      }
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`gemini_http_${response.status}:${text.slice(0, 200)}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("gemini_http_parse");
  }

  const image = extractInlineImage(json);
  if (!image) throw new GeminiEmptyError(extractUsage(json));
  return {
    bytes: Buffer.from(image.data, "base64"),
    mimeType: image.mimeType,
    usage: extractUsage(json)
  };
}
