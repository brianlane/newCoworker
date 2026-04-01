import { createHmac, timingSafeEqual } from "crypto";

type OnboardingTokenPayload = {
  businessId: string;
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

export function createOnboardingToken(payload: OnboardingTokenPayload): string {
  const encodedPayload = encodePayload(payload);
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function verifyOnboardingToken(token: string, expected: OnboardingTokenPayload): boolean {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return false;

  const expectedSignature = signPayload(encodedPayload);
  const signatureMatches =
    signature.length === expectedSignature.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));

  if (!signatureMatches) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as OnboardingTokenPayload;
    return payload.businessId === expected.businessId;
  } catch {
    return false;
  }
}

export function createPendingOwnerEmail(businessId: string): string {
  return `pending+${businessId}@onboarding.local`;
}
