/**
 * DOCX support — decode Word documents to plain text.
 *
 * Gemini has native document understanding for PDFs only, so `.docx` inputs
 * are decoded locally (mammoth) before any model call. Shared by document
 * ingestion, agent runs, doc_extract, and the dashboard-chat attachment
 * boundary so every surface treats Word files identically. mammoth is
 * imported lazily so pure-constant importers (mime checks, output targets)
 * never pull the parser into their bundle.
 */

export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Canonical-mime check for a Word upload: the real DOCX mime, or a blank /
 * octet-stream reported type under a `.docx` filename (browsers do both —
 * same tolerance the VTT normalization applies).
 */
export function isDocxUpload(mime: string, filename: string): boolean {
  if (mime === DOCX_MIME_TYPE) return true;
  const generic = mime === "" || mime === "application/octet-stream";
  return generic && /\.docx$/i.test(filename.trim());
}

/**
 * Decode DOCX bytes to plain text. Returns null when the bytes are not a
 * readable Word document (corrupt zip, wrong format) or carry no text —
 * a PERMANENT input problem callers report without retrying.
 */
export async function decodeDocxToText(data: Buffer): Promise<string | null> {
  const mammoth = (await import("mammoth")).default;
  try {
    const result = await mammoth.extractRawText({ buffer: data });
    const text = result.value.replace(/\u0000/g, "").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export type DocxAttachment = { filename: string; mimeType: string; data: Buffer };

/**
 * Boundary conversion for chat-style attachments: a DOCX attachment becomes
 * a plain-text one (decoded content, same filename) so downstream prompt
 * builders never see a mime Gemini can't take inline. Non-DOCX attachments
 * pass through untouched; an unreadable DOCX returns null so the caller can
 * refuse with an honest message.
 */
export async function decodeDocxAttachment(
  attachment: DocxAttachment
): Promise<DocxAttachment | null> {
  if (attachment.mimeType.trim().toLowerCase() !== DOCX_MIME_TYPE) return attachment;
  const text = await decodeDocxToText(attachment.data);
  if (text === null) return null;
  return {
    filename: attachment.filename,
    mimeType: "text/plain",
    data: Buffer.from(text, "utf8")
  };
}
