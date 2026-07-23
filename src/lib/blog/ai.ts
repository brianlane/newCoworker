/**
 * AI assist for the admin blog editor: draft a post from a topic, translate
 * a post to Spanish, and generate a 16:9 featured image — all via the
 * platform Gemini key (GOOGLE_API_KEY / GEMINI_API_KEY).
 */

import { geminiGenerateText } from "@/lib/gemini-generate-content";
import { geminiGenerateImage } from "@/lib/gemini-generate-image";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { BLOG_CATEGORIES, BLOG_IMAGES_BUCKET, type BlogCategory } from "./db";
import { stripEmDashes } from "./copy";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const DEFAULT_BLOG_AI_TEXT_MODEL = "gemini-3.5-flash";
export const DEFAULT_BLOG_AI_IMAGE_MODEL = "gemini-3.1-flash-lite-image";

function geminiApiKey(): string {
  return process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
}

function textModel(): string {
  return process.env.BLOG_DIGEST_TEXT_MODEL ?? DEFAULT_BLOG_AI_TEXT_MODEL;
}

const BRAND_CONTEXT =
  "New Coworker is an AI coworker for small businesses: it answers calls and " +
  "texts, books appointments, and follows up with leads so owners never miss " +
  "business. Audience: busy small-business owners. Voice: plain, friendly, " +
  "benefit-first, zero jargon. Never call the product an answering service.";

export type BlogAiDraft = {
  title: string;
  excerpt: string;
  content: string;
  category: BlogCategory;
};

/** Draft a full post (title/excerpt/markdown/category) from a topic brief. */
export async function draftBlogPostWithAi(
  topic: string,
  generateText: typeof geminiGenerateText = geminiGenerateText
): Promise<BlogAiDraft> {
  const raw = await generateText({
    apiKey: geminiApiKey(),
    model: textModel(),
    systemInstruction:
      `You write posts for the New Coworker blog. ${BRAND_CONTEXT} ` +
      "Structure the body with '## ' section headings and keep it focused " +
      "(500-900 words). Markdown pipe tables are supported — use one when " +
      "comparing options or listing structured facts. Never use em dashes; " +
      "use commas or periods instead. The excerpt is 1-2 " +
      "friendly sentences (it doubles as " +
      "an Instagram caption, so no links and no markdown). Pick the best " +
      `category from: ${BLOG_CATEGORIES.join(", ")}. ` +
      'Respond with JSON: {"title": string, "excerpt": string, ' +
      '"content": string (markdown), "category": string}.',
    userText: topic,
    responseMimeType: "application/json",
    thinkingLevel: "low",
    maxOutputTokens: 8192
  });
  const parsed = JSON.parse(raw) as Partial<BlogAiDraft>;
  if (!parsed.title || !parsed.excerpt || !parsed.content) {
    throw new Error("blog-ai: draft response missing fields");
  }
  const category = BLOG_CATEGORIES.includes(parsed.category as BlogCategory)
    ? (parsed.category as BlogCategory)
    : "announcement";
  // House rule: no em dashes in blog copy, ever.
  return {
    title: stripEmDashes(parsed.title),
    excerpt: stripEmDashes(parsed.excerpt),
    content: stripEmDashes(parsed.content),
    category
  };
}

export type BlogAiTranslation = {
  title_es: string;
  excerpt_es: string;
  content_es: string;
};

/** Translate a post's title/excerpt/markdown body to Latin-American Spanish. */
export async function translateBlogPostWithAi(
  post: { title: string; excerpt: string; content: string },
  generateText: typeof geminiGenerateText = geminiGenerateText
): Promise<BlogAiTranslation> {
  const raw = await generateText({
    apiKey: geminiApiKey(),
    model: textModel(),
    systemInstruction:
      "Translate this New Coworker blog post to natural Latin-American Spanish " +
      "for small-business owners. Keep the markdown structure, links, and code " +
      "exactly; translate only the prose. Keep the brand name 'New Coworker' " +
      "and the phrase 'coworker de IA' for 'AI coworker'. " +
      'Respond with JSON: {"title_es": string, "excerpt_es": string, "content_es": string}.',
    userText: JSON.stringify(post),
    responseMimeType: "application/json",
    thinkingLevel: "low",
    maxOutputTokens: 8192
  });
  const parsed = JSON.parse(raw) as Partial<BlogAiTranslation>;
  if (!parsed.title_es || !parsed.excerpt_es || !parsed.content_es) {
    throw new Error("blog-ai: translation response missing fields");
  }
  return {
    title_es: stripEmDashes(parsed.title_es),
    excerpt_es: stripEmDashes(parsed.excerpt_es),
    content_es: stripEmDashes(parsed.content_es)
  };
}

/**
 * Generate a 16:9 featured image for a post and upload it to the public
 * blog-images bucket. Returns the storage path.
 */
export async function generateBlogImageWithAi(
  post: { title: string; excerpt: string },
  db: SupabaseClient,
  generateImage: typeof geminiGenerateImage = geminiGenerateImage
): Promise<string> {
  const image = await generateImage({
    apiKey: geminiApiKey(),
    model: process.env.BLOG_DIGEST_IMAGE_MODEL ?? DEFAULT_BLOG_AI_IMAGE_MODEL,
    prompt:
      "Modern, friendly blog hero illustration for a small-business software " +
      `post titled "${post.title}" (${post.excerpt.slice(0, 200)}). ` +
      "Flat vector style, dark teal and green palette, no text, no logos.",
    aspectRatio: "16:9"
  });
  const ext = image.mimeType === "image/jpeg" ? "jpg" : "png";
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await db.storage
    .from(BLOG_IMAGES_BUCKET)
    .upload(path, image.bytes, { contentType: image.mimeType });
  if (error) throw new Error(`blog-ai: image upload failed: ${error.message}`);
  return path;
}
