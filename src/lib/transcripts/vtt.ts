/**
 * WebVTT transcript handling — the format Zoom (and Meet/Teams) produce for
 * meeting recordings. Uploading one anywhere documents/agents accept text
 * should "just work", so this module owns:
 *
 *   - recognizing a VTT upload (mime `text/vtt`, or a `.vtt` filename when
 *     the browser reports a blank/octet-stream type — common for VTT);
 *   - converting cue soup into clean "Speaker: sentence" lines (headers,
 *     cue ids, timestamps, and settings stripped; consecutive cues from the
 *     same speaker merged) so Gemini prompts read like a meeting, not a
 *     subtitle file.
 *
 * Pure functions only — the ingest/run pipelines call these before their
 * existing text paths.
 */

export const VTT_MIME_TYPE = "text/vtt";

/** `HH:MM:SS.mmm --> HH:MM:SS.mmm` (hours optional) with optional settings. */
const CUE_TIMING_RE =
  /^(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}.*$/;

/**
 * Is this upload a VTT transcript? Trusts the mime when present; falls back
 * to the extension because browsers frequently report "" or
 * application/octet-stream for .vtt files.
 */
export function isVttUpload(mime: string, filename: string): boolean {
  const m = mime.trim().toLowerCase();
  if (m === VTT_MIME_TYPE) return true;
  if (m === "" || m === "application/octet-stream") {
    return filename.trim().toLowerCase().endsWith(".vtt");
  }
  return false;
}

/**
 * WebVTT → readable transcript text. Keeps `Speaker: words` payload lines
 * (merging consecutive cues from the same speaker), drops the WEBVTT
 * header, NOTE/STYLE/REGION blocks, numeric cue ids, timing lines, and
 * inline `<v Speaker>` / timestamp tags. Returns "" for input with no
 * payload — callers treat that as empty content.
 */
export function vttToPlainText(raw: string): string {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const out: string[] = [];
  let inSkipBlock = false;
  let lastSpeaker: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      inSkipBlock = false;
      continue;
    }
    if (/^WEBVTT/i.test(trimmed)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(trimmed)) {
      inSkipBlock = true;
      continue;
    }
    if (inSkipBlock) continue;
    if (CUE_TIMING_RE.test(trimmed)) continue;
    // Bare numeric cue identifiers ("1", "42").
    if (/^\d+$/.test(trimmed)) continue;

    // Inline tags: `<v Jane Doe>text</v>` carries the speaker; other tags
    // (<c>, <i>, timestamps like <00:01:02.000>) are decoration. Stripped
    // to a fixpoint so overlapping sequences ("<scr<i>ipt>") can't re-form
    // a tag after one pass — the output feeds model prompts as plain text,
    // but stable stripping costs nothing and satisfies static analysis.
    let text = trimmed;
    let speaker: string | null = null;
    const voice = /^<v(?:\.[^ >]*)?\s+([^>]+)>/.exec(text);
    if (voice) speaker = voice[1].trim();
    let previous: string;
    do {
      previous = text;
      text = text.replace(/<[^>]*>/g, "");
    } while (text !== previous);
    text = text.trim();
    if (text.length === 0) continue;

    // Zoom's cue payload is usually "Name: words" already.
    if (!speaker) {
      const zoomStyle = /^([^:]{1,60}):\s+(.*)$/.exec(text);
      if (zoomStyle && zoomStyle[2].trim().length > 0) {
        speaker = zoomStyle[1].trim();
        text = zoomStyle[2].trim();
      }
    }

    if (speaker && speaker === lastSpeaker && out.length > 0) {
      // Same speaker continuing — merge into their running line.
      out[out.length - 1] += ` ${text}`;
    } else if (speaker) {
      out.push(`${speaker}: ${text}`);
      lastSpeaker = speaker;
    } else {
      out.push(text);
      lastSpeaker = null;
    }
  }
  return out.join("\n").trim();
}
