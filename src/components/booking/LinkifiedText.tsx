import { linkifyText } from "@/lib/booking-page/linkify-text";

/**
 * Render owner free text with bare http(s) URLs as new-tab anchors.
 * Used on the public booking page for description, intake labels, and help.
 */
export function LinkifiedText({ text }: { text: string }) {
  const segments = linkifyText(text);
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "url" ? (
          <a
            key={i}
            href={seg.value}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-claw-green hover:opacity-90"
          >
            {seg.value}
          </a>
        ) : (
          <span key={i}>{seg.value}</span>
        )
      )}
    </>
  );
}
