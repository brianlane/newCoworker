import { describe, expect, it } from "vitest";

import {
  deriveWrongGuestName,
  extractHostAddressedNames,
  guestNameFromTitle,
  guestNameVariants,
  renameGuestInText,
  replaceWholeWord
} from "@/lib/meetings/rename-guest";

/**
 * Correcting a wrongly-named guest. The rewrite runs over a whole
 * transcript, so the tests that matter are the ones about what it must NOT
 * touch: a different person whose name starts the same, our own side of the
 * call, and a name too short to match safely.
 */

const VTT = [
  "WEBVTT",
  "",
  "1",
  "00:00:01.000 --> 00:00:04.000",
  "Brian Lane: Hey, Bobby.",
  "",
  "2",
  "00:00:05.000 --> 00:00:09.000",
  "Alexander: Oh, good. Hi, morning.",
  "",
  "3",
  "00:00:10.000 --> 00:00:14.000",
  "Brian Lane: Wait, before we continue, Bobby, can I ask you a question?",
  ""
].join("\n");

describe("replaceWholeWord", () => {
  it("rewrites the name and its possessive", () => {
    expect(replaceWholeWord("Alexander said Alexander's rate", "Alexander", "Bobby")).toBe(
      "Bobby said Bobby's rate"
    );
  });

  it("leaves a different name that merely starts the same alone", () => {
    expect(replaceWholeWord("Alexandra and Alexander", "Alexander", "Bobby")).toBe(
      "Alexandra and Bobby"
    );
  });

  it("matches regardless of case but writes the replacement verbatim", () => {
    expect(replaceWholeWord("ALEXANDER and alexander", "Alexander", "Bobby")).toBe(
      "Bobby and Bobby"
    );
  });

  it("treats regex metacharacters in a display name as literal text", () => {
    expect(replaceWholeWord("a.b spoke", "a.b", "Bobby")).toBe("Bobby spoke");
    // The escaped dot must not match any character: "axb" stays put.
    expect(replaceWholeWord("axb spoke", "a.b", "Bobby")).toBe("axb spoke");
  });

  it("is a no-op for an empty name", () => {
    expect(replaceWholeWord("unchanged", "   ", "Bobby")).toBe("unchanged");
  });
});

describe("guestNameVariants", () => {
  it("returns the single name as-is", () => {
    expect(guestNameVariants("Alexander")).toEqual(["Alexander"]);
  });

  it("adds the first name, longest form first", () => {
    expect(guestNameVariants("Alexander Delacroix")).toEqual([
      "Alexander Delacroix",
      "Alexander"
    ]);
  });

  it("drops a first name too short to match safely", () => {
    expect(guestNameVariants("Al Delacroix")).toEqual(["Al Delacroix"]);
  });

  it("drops a first name that is also a host's, so our own side survives", () => {
    expect(guestNameVariants("Brian Delacroix", ["Brian Lane"])).toEqual(["Brian Delacroix"]);
  });

  it("returns nothing for an empty name", () => {
    expect(guestNameVariants("  ")).toEqual([]);
  });
});

describe("renameGuestInText", () => {
  it("rewrites the full name and the bare first name in one pass", () => {
    const text = "Alexander Delacroix joined. Alexander explained the model.";
    expect(renameGuestInText(text, "Alexander Delacroix", "Bobby")).toBe(
      "Bobby joined. Bobby explained the model."
    );
  });

  it("rewrites speaker labels in the dialogue under the minutes", () => {
    expect(renameGuestInText("Alexander: Yes, that is right.", "Alexander", "Bobby")).toBe(
      "Bobby: Yes, that is right."
    );
  });

  it("refuses to blank the guest out when the replacement is empty", () => {
    expect(renameGuestInText("Alexander spoke", "Alexander", "   ")).toBe("Alexander spoke");
  });

  it("leaves the text alone when there is no wrong name to rewrite", () => {
    expect(renameGuestInText("Alexander spoke", "", "Bobby")).toBe("Alexander spoke");
  });
});

describe("guestNameFromTitle", () => {
  it("reads the leading token of an import-titled document", () => {
    expect(guestNameFromTitle("Alexander Zoom meeting recording")).toBe("Alexander");
  });

  it("reads only the first token of a longer lead", () => {
    expect(guestNameFromTitle("Bobby Platform Overview Zoom meeting recording")).toBe("Bobby");
  });

  it("ignores a title the owner wrote themselves", () => {
    expect(guestNameFromTitle("Q3 planning notes")).toBeNull();
  });

  it("ignores a bare suffix with no guest in front of it", () => {
    expect(guestNameFromTitle("Zoom meeting recording")).toBeNull();
  });
});

describe("deriveWrongGuestName", () => {
  it("prefers the fuller speaker label when it extends the title's name", () => {
    const vtt = VTT.replace("Alexander:", "Alexander Delacroix:");
    expect(
      deriveWrongGuestName({
        title: "Alexander Zoom meeting recording",
        vtt,
        hostNames: ["Brian Lane"]
      })
    ).toBe("Alexander Delacroix");
  });

  it("keeps the title's name when the transcript names somebody else", () => {
    expect(
      deriveWrongGuestName({
        title: "Alexander Zoom meeting recording",
        vtt: VTT.replace("Alexander:", "Priya Raman:"),
        hostNames: ["Brian Lane"]
      })
    ).toBe("Alexander");
  });

  it("falls back to the speaker label when the title says nothing", () => {
    expect(
      deriveWrongGuestName({
        title: "Renamed by the owner",
        vtt: VTT,
        hostNames: ["Brian Lane"]
      })
    ).toBe("Alexander");
  });

  it("answers null when neither source names a guest", () => {
    expect(
      deriveWrongGuestName({ title: "Renamed by the owner", vtt: "", hostNames: ["Brian Lane"] })
    ).toBeNull();
  });
});

describe("extractHostAddressedNames", () => {
  it("finds the name the host called the guest, in both vocative positions", () => {
    expect(extractHostAddressedNames(VTT, ["Brian Lane"])).toEqual(["Bobby"]);
  });

  it("reads only our side, so a guest naming a third party is ignored", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.000",
      "Alexander: Thanks, Priya, I will send it over.",
      ""
    ].join("\n");
    expect(extractHostAddressedNames(vtt, ["Brian Lane"])).toEqual([]);
  });

  it("never returns a name from our own side, matched on host TOKENS", () => {
    // Bugbot, PR #1618: the host set was built from whole display names
    // ("brian lane") while a vocative is a first name, so "Thanks, Brian."
    // offered Brian as the guest and a contact named Brian would have
    // collected the meeting. Note the host list here carries only the FULL
    // name, which is what the import actually resolves.
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.000",
      "Brian Lane: Thanks, Brian. And hello, Bobby.",
      ""
    ].join("\n");
    expect(extractHostAddressedNames(vtt, ["New Coworker", "Brian Lane"])).toEqual(["Bobby"]);
  });

  it("returns each name once even when the host repeats it", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.000",
      "Brian Lane: Hey, Bobby.",
      "",
      "2",
      "00:00:05.000 --> 00:00:07.000",
      "Brian Lane: Right, Bobby.",
      ""
    ].join("\n");
    expect(extractHostAddressedNames(vtt, ["Brian Lane"])).toEqual(["Bobby"]);
  });

  it("ignores a capitalized word that is not in a vocative slot", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.000",
      "Brian Lane: We can integrate with Denver listings this quarter.",
      ""
    ].join("\n");
    expect(extractHostAddressedNames(vtt, ["Brian Lane"])).toEqual([]);
  });

  it("ignores lines with no speaker label at all", () => {
    expect(extractHostAddressedNames("WEBVTT\n\nno speaker here, Bobby.\n", ["Brian Lane"])).toEqual(
      []
    );
  });

  it("ignores an empty host name rather than matching every speaker", () => {
    expect(extractHostAddressedNames(VTT, ["  "])).toEqual([]);
  });
});
