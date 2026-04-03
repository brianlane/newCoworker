import { createHmac, timingSafeEqual } from "crypto";

const TOKEN_TTL_MS = 10 * 60 * 1000;

type GoogleOAuthStatePayload = {
  businessId: string;
  state: string;
  issuedAt: number;
};

function getGoogleOAuthStateSecret(): string {
  const secret =
    process.env.GOOGLE_OAUTH_STATE_SECRET ??
    process.env.ONBOARDING_TOKEN_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret) {
    throw new Error("GOOGLE_OAUTH_STATE_SECRET is not configured");
  }

  return secret;
}

function encodePayload(payload: GoogleOAuthStatePayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function signPayload(encodedPayload: string): string {
  return createHmac("sha256", getGoogleOAuthStateSecret()).update(encodedPayload).digest("base64url");
}

export function createGoogleOAuthStateToken(payload: { businessId: string; state: string }): string {
  const encodedPayload = encodePayload({ ...payload, issuedAt: Date.now() });
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function parseGoogleOAuthStateToken(
  token: string
): Pick<GoogleOAuthStatePayload, "businessId" | "state"> | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;

  const expectedSignature = signPayload(encodedPayload);
  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedSignatureBuffer = Buffer.from(expectedSignature, "utf8");
  const signatureMatches =
    signatureBuffer.length === expectedSignatureBuffer.length &&
    timingSafeEqual(signatureBuffer, expectedSignatureBuffer);

  if (!signatureMatches) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as GoogleOAuthStatePayload;

    if (!payload.businessId || !payload.state) return null;
    if (typeof payload.issuedAt !== "number") return null;
    if (Date.now() - payload.issuedAt > TOKEN_TTL_MS) return null;

    return {
      businessId: payload.businessId,
      state: payload.state
    };
  } catch {
    return null;
  }
}
