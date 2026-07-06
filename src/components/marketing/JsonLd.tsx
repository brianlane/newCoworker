/**
 * Renders a schema.org JSON-LD block. Server component; data must be a
 * plain serializable object. JSON.stringify output is safe to inline as
 * long as `<` is escaped so user-ish strings can't close the script tag.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
