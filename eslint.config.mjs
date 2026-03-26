import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  { ignores: ["coverage/**", ".next/**", "node_modules/**"] },
  ...nextVitals,
];

export default config;
