import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  { ignores: ["coverage/**", ".next/**", "node_modules/**", "**/*.d.mts"] },
  ...nextVitals,
];

export default config;
