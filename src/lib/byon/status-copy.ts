/**
 * Owner-facing copy for BYON port requests.
 *
 * Losing-carrier rejections are the #1 support driver for number ports, so
 * every Telnyx status and exception code maps to plain language plus a
 * concrete "here's how you fix it" line. Pure functions — the wizard and the
 * status card render whatever comes out of here.
 */

import type { PortingExceptionDetail } from "@/lib/telnyx/porting";

export type ByonBadgeVariant = "neutral" | "pending" | "success" | "error";

export type ByonStatusDisplay = {
  /** Short badge text ("Submitted", "Action needed", …). */
  label: string;
  variant: ByonBadgeVariant;
  /** One-sentence plain-language description of where the port stands. */
  line: string;
};

const STATUS_COPY: Record<string, ByonStatusDisplay> = {
  draft: {
    label: "Draft",
    variant: "neutral",
    line: "Not submitted to your current carrier yet."
  },
  "in-process": {
    label: "In progress",
    variant: "pending",
    line: "Telnyx is preparing the request for your current carrier."
  },
  submitted: {
    label: "Submitted",
    variant: "pending",
    line: "Waiting on your current carrier to approve the transfer."
  },
  exception: {
    label: "Action needed",
    variant: "error",
    line: "Your current carrier rejected the request — see the fix below and resubmit."
  },
  "foc-date-confirmed": {
    label: "Date confirmed",
    variant: "success",
    line: "Your carrier approved the transfer and confirmed the switch date."
  },
  ported: {
    label: "Ported",
    variant: "success",
    line: "Done — this number now rings your AI coworker."
  },
  "cancel-pending": {
    label: "Cancelling",
    variant: "pending",
    line: "Cancellation requested; waiting on carrier confirmation."
  },
  cancelled: {
    label: "Cancelled",
    variant: "neutral",
    line: "This port was cancelled. Your service stays with your current carrier."
  }
};

export function byonStatusDisplay(status: string): ByonStatusDisplay {
  return (
    STATUS_COPY[status] ?? {
      label: status,
      variant: "neutral",
      line: "We're tracking this port and will notify you when anything changes."
    }
  );
}

/**
 * Telnyx exception codes → what the owner should actually do. Wording keys
 * off the wizard's field names so "go fix it" is unambiguous.
 */
const EXCEPTION_GUIDANCE: Record<string, string> = {
  ACCOUNT_NUMBER_MISMATCH:
    "The account number didn't match your carrier's records — check a recent bill for the exact account number and resubmit.",
  AUTH_PERSON_MISMATCH:
    "The authorized person's name didn't match the carrier account — use the name exactly as it appears on your bill.",
  BTN_ATN_MISMATCH:
    "The billing phone number didn't match the carrier account — enter the main billing number from your bill.",
  ENTITY_NAME_MISMATCH:
    "The business name didn't match your carrier's records — copy it exactly as printed on your bill.",
  FOC_EXPIRED:
    "The confirmed switch date passed before the port completed — resubmit to get a new date.",
  FOC_REJECTED:
    "Your carrier rejected the requested switch date — pick a later date and resubmit.",
  LOCATION_MISMATCH:
    "The service address didn't match your carrier's records — use the address from your bill, not your mailing address.",
  LSR_PENDING:
    "There's already another pending transfer request on this number — cancel it with your carrier first.",
  MAIN_BTN_PORTING:
    "This is the main billing number of your account — ask your carrier to assign a new billing number before porting it.",
  OSP_IRRESPONSIVE:
    "Your current carrier isn't responding to the request — no action needed from you; Telnyx support is following up.",
  PASSCODE_PIN_INVALID:
    "The PIN/passcode was wrong — get your transfer PIN from your carrier and resubmit.",
  PHONE_NUMBER_HAS_SPECIAL_FEATURE:
    "This number has a feature (like call forwarding bundles or DSL) blocking the port — ask your carrier to remove it first.",
  PHONE_NUMBER_MISMATCH:
    "Your carrier doesn't recognize this number on the account — double-check the number and the account it belongs to.",
  PHONE_NUMBER_NOT_PORTABLE:
    "Your carrier says this number can't be transferred — contact them to ask why.",
  PORT_TYPE_INCORRECT:
    "The carrier expects a different port type for this account — contact support and we'll adjust it.",
  PORTING_ORDER_SPLIT_REQUIRED:
    "These numbers have to move in separate requests — resubmit them individually.",
  POSTAL_CODE_MISMATCH:
    "The ZIP code didn't match your carrier's records — use the ZIP from the service address on your bill.",
  RATE_CENTER_NOT_PORTABLE:
    "This number's local exchange isn't portable to Telnyx coverage — the number can't move as-is.",
  SV_CONFLICT:
    "Another provider has a competing claim on this number — cancel any other pending transfers and resubmit."
};

const FALLBACK_GUIDANCE =
  "Your carrier reported an issue with the request — review the details and resubmit, or contact support with your reference key.";

/** Plain-language fixes for the exception details on a request row. */
export function byonExceptionFixes(details: PortingExceptionDetail[] | null): string[] {
  if (!details || details.length === 0) return [];
  const fixes: string[] = [];
  for (const detail of details) {
    const guidance =
      (detail.code ? EXCEPTION_GUIDANCE[detail.code] : undefined) ??
      detail.description ??
      FALLBACK_GUIDANCE;
    if (!fixes.includes(guidance)) fixes.push(guidance);
  }
  return fixes;
}

/** Statuses from which the owner can still call the port off. */
export function byonCanCancel(status: string): boolean {
  return !["ported", "cancelled", "cancel-pending"].includes(status);
}
