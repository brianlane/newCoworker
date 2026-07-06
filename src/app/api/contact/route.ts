import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { sendOwnerEmail } from "@/lib/email/client";
import {
  rateLimitDurable,
  rateLimitIdentifierFromRequest
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Public contact-form endpoint for /contact. Unauthenticated by design, so
 * it is IP rate-limited and honeypot-protected; the submission is delivered
 * to the CONTACT_EMAIL inbox via Resend.
 */

const MAX_NAME = 120;
const MAX_EMAIL = 254;
const MAX_BUSINESS = 160;
const MAX_SUBJECT = 200;
const MAX_MESSAGE = 5000;

// Same permissive shape the rest of the app uses at input boundaries:
// something@something.tld, no whitespace.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CONTACT_RATE_LIMIT = { interval: 10 * 60 * 1000, maxRequests: 5 };

type ContactPayload = {
  name: string;
  email: string;
  businessName: string;
  subject: string;
  message: string;
  /**
   * Honeypot: real users never fill this hidden field. Named so browser
   * autofill heuristics (website/url/org/phone) never populate it and
   * silently drop a legitimate submission.
   */
  extraField: string;
};

function readString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function parsePayload(body: unknown): ContactPayload {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    name: readString(b.name, MAX_NAME),
    email: readString(b.email, MAX_EMAIL),
    businessName: readString(b.businessName, MAX_BUSINESS),
    subject: readString(b.subject, MAX_SUBJECT),
    message: readString(b.message, MAX_MESSAGE),
    extraField: readString(b.extraField, 200)
  };
}

export async function POST(request: Request) {
  const identifier = `contact-form:${rateLimitIdentifierFromRequest(request)}`;
  const limit = await rateLimitDurable(identifier, CONTACT_RATE_LIMIT);
  if (!limit.success) {
    return NextResponse.json(
      { error: "Too many messages. Please try again in a few minutes." },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const payload = parsePayload(body);

  // Bots that fill every field trip the honeypot; answer 200 so they move on.
  if (payload.extraField.length > 0) {
    return NextResponse.json({ ok: true });
  }

  if (!payload.name || !payload.subject || !payload.message) {
    return NextResponse.json(
      { error: "Name, subject, and message are required." },
      { status: 400 }
    );
  }
  if (!EMAIL_RE.test(payload.email)) {
    return NextResponse.json(
      { error: "Please enter a valid email address." },
      { status: 400 }
    );
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn("contact form email skipped: RESEND_API_KEY missing");
    return NextResponse.json(
      { error: "Messaging is temporarily unavailable. Please email us directly." },
      { status: 503 }
    );
  }

  const toEmail = process.env.CONTACT_EMAIL ?? "team@newcoworker.com";
  const lines = [
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    payload.businessName ? `Business: ${payload.businessName}` : null,
    "",
    payload.message
  ].filter((l): l is string => l !== null);

  try {
    // Reply-To is the submitter so replying in a mail client reaches them,
    // not the inbox that received the notification.
    const messageId = await sendOwnerEmail(apiKey, toEmail, `[Contact form] ${payload.subject}`, {
      text: lines.join("\n"),
      replyTo: payload.email
    });
    // Resend reports failures as { data: null, error } without throwing, so
    // a missing message id means the email was NOT sent.
    if (!messageId) {
      logger.warn("contact form email not accepted by Resend");
      return NextResponse.json(
        { error: "We couldn't send your message. Please try again." },
        { status: 502 }
      );
    }
  } catch (err) {
    logger.warn("contact form email failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return NextResponse.json(
      { error: "We couldn't send your message. Please try again." },
      { status: 502 }
    );
  }

  logger.info("contact form submission delivered", { toEmail });
  return NextResponse.json({ ok: true });
}
