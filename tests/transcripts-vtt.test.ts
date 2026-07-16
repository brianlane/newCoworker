/**
 * WebVTT transcript handling (src/lib/transcripts/vtt.ts): upload
 * recognition (mime + extension fallback) and cue-soup → "Speaker:
 * sentence" conversion.
 */
import { describe, expect, it } from "vitest";

import { isVttUpload, vttToPlainText, VTT_MIME_TYPE } from "@/lib/transcripts/vtt";

describe("isVttUpload", () => {
  it("trusts the text/vtt mime regardless of filename", () => {
    expect(isVttUpload("text/vtt", "anything.bin")).toBe(true);
    expect(isVttUpload(" TEXT/VTT ", "x")).toBe(true);
  });

  it("falls back to the .vtt extension for blank/octet-stream types", () => {
    expect(isVttUpload("", "meeting.vtt")).toBe(true);
    expect(isVttUpload("application/octet-stream", "Meeting.VTT")).toBe(true);
    expect(isVttUpload("", "meeting.txt")).toBe(false);
  });

  it("never reclassifies a real reported type", () => {
    expect(isVttUpload("text/plain", "meeting.vtt")).toBe(false);
    expect(isVttUpload("application/pdf", "meeting.vtt")).toBe(false);
  });
});

describe("vttToPlainText", () => {
  it("strips headers/ids/timings and merges consecutive cues per speaker (Zoom style)", () => {
    const vtt = [
      "\uFEFFWEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.000",
      "Dania Shaikh: Thanks for joining, everyone.",
      "",
      "2",
      "00:00:04.500 --> 00:00:08.000",
      "Dania Shaikh: Let's review the renewal book first.",
      "",
      "3",
      "00:00:08.500 --> 00:00:12.000",
      "Brian Lane: Sounds good — I have the July numbers."
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe(
      [
        "Dania Shaikh: Thanks for joining, everyone. Let's review the renewal book first.",
        "Brian Lane: Sounds good — I have the July numbers."
      ].join("\n")
    );
  });

  it("reads <v Speaker> voice tags and drops decoration tags + NOTE/STYLE blocks", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE",
      "confidence data follows",
      "still inside the note block",
      "",
      "00:01.000 --> 00:02.000 align:start",
      "<v Jane Doe><i>Hello</i> there</v>",
      "",
      "00:02.000 --> 00:03.000",
      "<v Jane Doe>again <00:00:02.500>with a timestamp</v>"
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Jane Doe: Hello there again with a timestamp");
  });

  it("keeps speakerless payload lines verbatim and handles comma millisecond separators", () => {
    const vtt = ["WEBVTT", "", "00:00:01,000 --> 00:00:02,000", "just narration"].join("\n");
    expect(vttToPlainText(vtt)).toBe("just narration");
  });

  it("keeps digits-only cue payload — only block-position numeric cue ids drop", () => {
    const vtt = [
      "WEBVTT",
      "",
      "7",
      "00:00:01.000 --> 00:00:02.000",
      "Dania: How many seats?",
      "",
      "8",
      "00:00:02.500 --> 00:00:03.500",
      "42"
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Dania: How many seats?\n42");
  });

  it("appends wrapped continuation lines of the SAME cue to the utterance above", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Dania: Hello",
      "everyone today",
      "",
      "00:00:04.500 --> 00:00:06.000",
      "Dania: Second cue"
    ].join("\n");
    // The continuation stays with Dania's line AND the speaker keeps
    // running, so the next cue from Dania merges too.
    expect(vttToPlainText(vtt)).toBe("Dania: Hello everyone today Second cue");
  });

  it("drops the whole WEBVTT header block (Kind/Language metadata), not just the signature", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: en-US",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Dania: Hello"
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("Dania: Hello");
  });

  it("keeps cue payload lines that START with NOTE — only block-position NOTE/STYLE/REGION skip", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE this really is a comment block",
      "with a second comment line",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "NOTE: review the contract before Friday"
    ].join("\n");
    expect(vttToPlainText(vtt)).toBe("NOTE: review the contract before Friday");
  });

  it("does not treat a colonless or empty-payload line as a speaker", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Note: ",
      "<c></c>"
    ].join("\n");
    // "Note: " has an empty remainder → kept verbatim; the empty tag line drops.
    expect(vttToPlainText(vtt)).toBe("Note:");
  });

  it("returns empty for headers-only input", () => {
    expect(vttToPlainText("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n")).toBe("");
    expect(vttToPlainText("")).toBe("");
  });

  it("exports the canonical mime", () => {
    expect(VTT_MIME_TYPE).toBe("text/vtt");
  });
});
