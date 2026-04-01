export function checkEnv(key: string): boolean {
  const val = process.env[key];
  return !!val && val.trim().length > 0;
}

export function getEnvDisplayValue(configured: boolean): string {
  return configured ? "configured" : "not set";
}
