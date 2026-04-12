import { timingSafeEqualUtf8 } from "@/lib/timing-safe-utf8";

/** Validates `Authorization: Bearer` against `ROWBOAT_GATEWAY_TOKEN` (Rowboat / VPS → app). */
export function verifyRowboatGatewayToken(request: Request): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const expected = process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  if (expected === "") return false;
  return timingSafeEqualUtf8(token, expected);
}
