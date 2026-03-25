import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "claw-green": "#1BD96A",
        "deep-ink": "#0D2235",
        "signal-teal": "#2EC4B6",
        parchment: "#F5F0E8",
        "spark-orange": "#FF6B35",
        "soft-stone": "#E8E3D8"
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
