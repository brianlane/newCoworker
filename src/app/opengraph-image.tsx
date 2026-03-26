import { ImageResponse } from "next/og";

export const alt = "New Coworker social preview";
export const size = {
  width: 1200,
  height: 630
};
export const contentType = "image/png";

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
          <img src="https://newcoworker.com/logo.png" width="72" height="72" alt="New Coworker logo" />
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
