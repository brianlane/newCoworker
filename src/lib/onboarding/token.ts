import { createHmac, timingSafeEqual } from "crypto";

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

type OnboardingTokenPayload = {
  businessId: string;
  issuedAt: number;
};

function getOnboardingTokenSecret(): string {
  const secret = process.env.ONBOARDING_TOKEN_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error("ONBOARDING_TOKEN_SECRET is not configured");
  }
  return secret;
}

function encodePayload(payload: OnboardingTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function signPayload(encodedPayload: string): string {
  return createHmac("sha256", getOnboardingTokenSecret()).update(encodedPayload).digest("base64url");
}

export function createOnboardingToken(payload: { businessId: string }): string {
  const fullPayload: OnboardingTokenPayload = { businessId: payload.businessId, issuedAt: Date.now() };
  const encodedPayload = encodePayload(fullPayload);
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function verifyOnboardingToken(token: string, expected: { businessId: string }): boolean {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return false;

  const expectedSignature = signPayload(encodedPayload);
  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedSignatureBuffer = Buffer.from(expectedSignature, "utf8");
  const signatureMatches =
    signatureBuffer.length === expectedSignatureBuffer.length &&
    timingSafeEqual(signatureBuffer, expectedSignatureBuffer);

  if (!signatureMatches) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as OnboardingTokenPayload;
    if (payload.businessId !== expected.businessId) return false;
    if (typeof payload.issuedAt !== "number") return false;
    if (Date.now() - payload.issuedAt > TOKEN_TTL_MS) return false;
    return true;
  } catch {
    return false;
  }
}

export function createPendingOwnerEmail(businessId: string): string {
  return `pending+${businessId}@onboarding.local`;
}
