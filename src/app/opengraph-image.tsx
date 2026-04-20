import { readFileSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";

// Force the Node runtime so build-time prerender can read the logo from disk.
// (Edge runtime has no `node:fs`, which would fall through to a remote fetch.)
export const runtime = "nodejs";

export const alt = "New Coworker social preview";
export const size = {
  width: 1200,
  height: 630
};
export const contentType = "image/png";

// Inline the logo as a base64 data URI rather than referencing the production
// URL (`https://newcoworker.com/logo.png`). During `next build` on Vercel the
// static prerender for this route fetches any remote `<img src>` through
// satori, and pointing it at the very domain being deployed creates a
// chicken-and-egg loop that hits the 60s export timeout. Reading the asset
// from `public/` sidesteps the network entirely and keeps the OG card
// perfectly static + reproducible.
const LOGO_DATA_URI = (() => {
  const buf = readFileSync(path.join(process.cwd(), "public", "logo.png"));
  return `data:image/png;base64,${buf.toString("base64")}`;
})();

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background:
            "radial-gradient(circle at 70% 20%, #0e3a35 0%, #0b2238 45%, #07172d 100%)",
          color: "#f8f3ea",
          padding: "64px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 30 }}>
          <img src={LOGO_DATA_URI} width={72} height={72} alt="New Coworker logo" />
          <div style={{ fontSize: 40, fontWeight: 700 }}>New Coworker</div>
        </div>
        <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.1, maxWidth: "90%" }}>
          Your AI employee that never sleeps
        </div>
        <div style={{ marginTop: 28, fontSize: 30, color: "#84f5bd" }}>
          Calls. Texts. Emails. 24/7.
        </div>
      </div>
    ),
    size
  );
}
