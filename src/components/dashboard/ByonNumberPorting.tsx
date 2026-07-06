"use client";

/**
 * Bring-your-own-number: self-serve port-in wizard + status card.
 *
 * Stepper mirrors what OpenPhone/Dialpad-style ports collect:
 *   1. Number → instant portability check ("ports in 1-4 business days")
 *   2. Carrier account details (account #, PIN, authorized name, service address)
 *   3. Download the prefilled LOA, upload the signed LOA + a recent bill, submit
 *
 * Below the wizard, every existing request renders as a status card with
 * plain-language status and, on carrier rejections, concrete fixes
 * (see src/lib/byon/status-copy.ts).
 */

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatDid } from "@/lib/telnyx/format";
import {
  byonCanCancel,
  byonExceptionFixes,
  byonStatusDisplay
} from "@/lib/byon/status-copy";
import type { NumberPortRequestRow } from "@/lib/byon/port-requests";
import { Download, FileCheck2, PhoneForwarded, Upload } from "lucide-react";

type Props = {
  businessId: string;
  initialRequests: NumberPortRequestRow[];
  /**
   * BYON is a Standard-tier perk. When false (Starter), the wizard is
   * replaced with an upgrade prompt but existing requests keep their
   * status card and cancel action (ports started before a downgrade, or
   * before the gate shipped, must stay visible).
   */
  wizardEnabled?: boolean;
};

type CheckResult = {
  phoneE164: string;
  portable: boolean;
  fastPortable: boolean;
  etaDays: string;
  notPortableReason: string | null;
  carrierName: string | null;
};

type ApiError = { error?: { message?: string } };

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as ApiError | null;
  return json?.error?.message || `HTTP ${res.status}`;
}

const MAX_DOC_BYTES = 5 * 1024 * 1024;

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const inputClass =
  "w-full rounded-lg border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm " +
  "text-parchment placeholder:text-parchment/30 focus:border-signal-teal/60 focus:outline-none";

const labelClass = "block text-xs text-parchment/50 mb-1";

const primaryBtn =
  "inline-flex items-center gap-1.5 rounded-lg bg-signal-teal text-deep-ink px-4 py-2 " +
  "text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40";

const secondaryBtn =
  "inline-flex items-center gap-1.5 rounded-lg border border-parchment/20 text-parchment/70 " +
  "px-3 py-2 text-xs hover:bg-parchment/5 transition-colors disabled:opacity-40";

export function ByonNumberPorting({ businessId, initialRequests, wizardEnabled = true }: Props) {
  const [requests, setRequests] = useState<NumberPortRequestRow[]>(initialRequests);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Step 1
  const [phone, setPhone] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);

  // Step 2
  const [entityName, setEntityName] = useState("");
  const [authorizedName, setAuthorizedName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [pin, setPin] = useState("");
  const [billingPhone, setBillingPhone] = useState("");
  const [carrierName, setCarrierName] = useState("");
  const [street, setStreet] = useState("");
  const [extended, setExtended] = useState("");
  const [city, setCity] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [zip, setZip] = useState("");

  // Step 3
  const [loaFile, setLoaFile] = useState<File | null>(null);
  const [billFile, setBillFile] = useState<File | null>(null);

  const detailsComplete = useMemo(
    () =>
      [entityName, authorizedName, accountNumber, street, city, stateCode, zip].every(
        (v) => v.trim().length > 0
      ),
    [entityName, authorizedName, accountNumber, street, city, stateCode, zip]
  );

  const carrierPayload = () => ({
    businessId,
    phone: check?.phoneE164 ?? phone,
    carrier: {
      entityName,
      authorizedName,
      accountNumber,
      ...(pin.trim() ? { pin } : {}),
      ...(billingPhone.trim() ? { billingPhone } : {})
    },
    serviceAddress: {
      street,
      ...(extended.trim() ? { extended } : {}),
      city,
      state: stateCode,
      zip
    }
  });

  async function runCheck() {
    setBusy("check");
    setError(null);
    setCheck(null);
    try {
      const res = await fetch("/api/dashboard/byon/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, phone })
      });
      if (!res.ok) throw new Error(await readError(res));
      const json = (await res.json()) as { data?: { check?: CheckResult } };
      if (json.data?.check) {
        setCheck(json.data.check);
        if (json.data.check.carrierName) setCarrierName(json.data.check.carrierName);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function downloadLoa() {
    setBusy("loa");
    setError(null);
    try {
      const res = await fetch("/api/dashboard/byon/loa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...carrierPayload(),
          ...(carrierName.trim() ? { carrierName } : {})
        })
      });
      if (!res.ok) throw new Error(await readError(res));
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "letter-of-authorization.pdf";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function validateDoc(file: File | null, label: string): string | null {
    if (!file) return `Upload the ${label} first.`;
    if (file.size > MAX_DOC_BYTES) return `The ${label} is too large (max 5 MB).`;
    return null;
  }

  async function submitPort() {
    const docError = validateDoc(loaFile, "signed LOA") ?? validateDoc(billFile, "recent bill");
    if (docError) {
      setError(docError);
      return;
    }
    setBusy("submit");
    setError(null);
    try {
      const [loaB64, billB64] = await Promise.all([
        fileToBase64(loaFile as File),
        fileToBase64(billFile as File)
      ]);
      const res = await fetch(
        `/api/dashboard/byon?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // businessId travels in the query string; zod strips the extra key.
          body: JSON.stringify({
            ...carrierPayload(),
            loa: { base64: loaB64, filename: (loaFile as File).name || "loa.pdf" },
            bill: { base64: billB64, filename: (billFile as File).name || "bill.pdf" }
          })
        }
      );
      if (!res.ok) throw new Error(await readError(res));
      const json = (await res.json()) as {
        data?: { rows?: NumberPortRequestRow[]; submitted?: boolean; submitError?: string | null };
      };
      const rows = json.data?.rows ?? [];
      setRequests((prev) => [...rows, ...prev]);
      if (json.data?.submitted) {
        setNotice(
          "Port request submitted. We'll text and email you as your carrier processes it. Most ports finish within a week."
        );
        // Reset the wizard for a potential next number.
        setStep(1);
        setPhone("");
        setCheck(null);
        setLoaFile(null);
        setBillFile(null);
      } else {
        // Saved but not submitted: keep every wizard field so the owner can
        // fix the issue and retry instead of starting over (which would
        // create yet another draft order for the same number).
        setNotice(null);
        setError(
          json.data?.submitError
            ? `Your request was saved but couldn't be submitted yet: ${json.data.submitError}`
            : "Your request was saved but couldn't be submitted yet."
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function cancelRequest(id: string) {
    setBusy(`cancel:${id}`);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/byon?businessId=${encodeURIComponent(businessId)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error(await readError(res));
      const json = (await res.json()) as { data?: { request?: NumberPortRequestRow } };
      const updated = json.data?.request;
      if (updated) {
        setRequests((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-xs text-red-300 border border-red-400/30 bg-red-400/5 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
      {notice && (
        <p className="text-xs text-claw-green border border-claw-green/30 bg-claw-green/5 rounded-lg px-3 py-2">
          {notice}
        </p>
      )}

      {!wizardEnabled && (
        <Card>
          <div className="text-center py-8 space-y-3">
            <p className="text-parchment/80 font-semibold">
              Bring-your-own-number is a Standard plan perk
            </p>
            <p className="text-parchment/60 text-sm max-w-md mx-auto">
              Upgrade to Standard to port the business number your customers already know. It
              transfers to your AI coworker in about a week.
            </p>
            <a
              href="/dashboard/billing"
              className="inline-block rounded-lg bg-claw-green text-deep-ink px-5 py-2.5 font-semibold text-sm hover:bg-opacity-90 transition-colors"
            >
              Upgrade to Standard →
            </a>
          </div>
        </Card>
      )}

      {wizardEnabled && (
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <PhoneForwarded className="h-4 w-4 text-signal-teal" />
          <h2 className="text-sm font-semibold text-parchment">Bring your own number</h2>
        </div>
        <p className="text-xs text-parchment/50 mb-4">
          Move your existing business number to your AI coworker. Calls and texts transfer over,
          your current service keeps working until the switch completes.
        </p>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-4 text-[11px]">
          {[
            [1, "Check number"],
            [2, "Account details"],
            [3, "Sign & submit"]
          ].map(([n, label]) => (
            <span
              key={n}
              className={
                "rounded-full px-2.5 py-1 border " +
                (step === n
                  ? "border-signal-teal/50 text-signal-teal bg-signal-teal/10"
                  : "border-parchment/15 text-parchment/40")
              }
            >
              {n}. {label}
            </span>
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-3">
            <div>
              <label htmlFor="byon-phone" className={labelClass}>
                Business number you want to bring
              </label>
              <div className="flex gap-2">
                <input
                  id="byon-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    // A stale check would let the wizard submit the OLD
                    // number (later steps use check.phoneE164): re-verify.
                    setCheck(null);
                  }}
                  placeholder="(312) 555-0001"
                  className={inputClass + " max-w-xs"}
                />
                <button
                  type="button"
                  onClick={() => void runCheck()}
                  disabled={busy !== null || phone.trim().length === 0}
                  className={primaryBtn}
                >
                  {busy === "check" ? "Checking…" : "Check my number"}
                </button>
              </div>
            </div>
            {check && check.portable && (
              <div className="rounded-lg border border-claw-green/30 bg-claw-green/5 px-3 py-2">
                <p className="text-sm text-claw-green">
                  {formatDid(check.phoneE164)} can move to your coworker, typically{" "}
                  {check.etaDays}.
                </p>
                {check.carrierName && (
                  <p className="text-xs text-parchment/50 mt-1">
                    Current carrier: {check.carrierName}
                  </p>
                )}
                <button type="button" onClick={() => setStep(2)} className={primaryBtn + " mt-3"}>
                  Start the transfer →
                </button>
              </div>
            )}
            {check && !check.portable && (
              <div className="rounded-lg border border-spark-orange/30 bg-spark-orange/5 px-3 py-2">
                <p className="text-sm text-spark-orange">
                  This number can&rsquo;t be transferred automatically.
                </p>
                <p className="text-xs text-parchment/60 mt-1">
                  {check.notPortableReason ?? "Your carrier doesn't support porting this number."}{" "}
                  You can keep using the number we assigned you, or contact support for options.
                </p>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-xs text-parchment/50">
              Enter these exactly as they appear on your carrier bill; mismatches are the most
              common reason carriers reject a transfer.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="byon-entity" className={labelClass}>
                  Business name on the account *
                </label>
                <input id="byon-entity" value={entityName} onChange={(e) => setEntityName(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label htmlFor="byon-auth" className={labelClass}>
                  Authorized person *
                </label>
                <input id="byon-auth" value={authorizedName} onChange={(e) => setAuthorizedName(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label htmlFor="byon-account" className={labelClass}>
                  Account number *
                </label>
                <input id="byon-account" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label htmlFor="byon-pin" className={labelClass}>
                  Transfer PIN / passcode
                </label>
                <input id="byon-pin" value={pin} onChange={(e) => setPin(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label htmlFor="byon-billing-phone" className={labelClass}>
                  Billing phone number
                </label>
                <input id="byon-billing-phone" type="tel" value={billingPhone} onChange={(e) => setBillingPhone(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label htmlFor="byon-carrier" className={labelClass}>
                  Current carrier
                </label>
                <input id="byon-carrier" value={carrierName} onChange={(e) => setCarrierName(e.target.value)} className={inputClass} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="byon-street" className={labelClass}>
                  Service street address *
                </label>
                <input id="byon-street" value={street} onChange={(e) => setStreet(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label htmlFor="byon-extended" className={labelClass}>
                  Suite / unit
                </label>
                <input id="byon-extended" value={extended} onChange={(e) => setExtended(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label htmlFor="byon-city" className={labelClass}>
                  City *
                </label>
                <input id="byon-city" value={city} onChange={(e) => setCity(e.target.value)} className={inputClass} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="byon-state" className={labelClass}>
                    State *
                  </label>
                  <input id="byon-state" value={stateCode} onChange={(e) => setStateCode(e.target.value)} placeholder="IL" className={inputClass} />
                </div>
                <div>
                  <label htmlFor="byon-zip" className={labelClass}>
                    ZIP *
                  </label>
                  <input id="byon-zip" value={zip} onChange={(e) => setZip(e.target.value)} className={inputClass} />
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button type="button" onClick={() => setStep(1)} className={secondaryBtn}>
                ← Back
              </button>
              <button
                type="button"
                onClick={() => setStep(3)}
                disabled={!detailsComplete}
                className={primaryBtn}
              >
                Continue →
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-3">
              <p className="text-xs text-parchment/70 mb-2">
                1. Download the Letter of Authorization we prefilled from your details, then sign
                it.
              </p>
              <button
                type="button"
                onClick={() => void downloadLoa()}
                disabled={busy !== null}
                className={secondaryBtn}
              >
                <Download className="h-3.5 w-3.5" />
                {busy === "loa" ? "Preparing…" : "Download prefilled LOA"}
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-3">
                <p className="text-xs text-parchment/70 mb-2">2. Upload the signed LOA (PDF).</p>
                <label className={secondaryBtn + " cursor-pointer"}>
                  <Upload className="h-3.5 w-3.5" />
                  {loaFile ? loaFile.name : "Choose signed LOA"}
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    aria-label="Upload signed LOA PDF"
                    onChange={(e) => setLoaFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
              <div className="rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-3">
                <p className="text-xs text-parchment/70 mb-2">
                  3. Upload a recent bill from your carrier (PDF).
                </p>
                <label className={secondaryBtn + " cursor-pointer"}>
                  <Upload className="h-3.5 w-3.5" />
                  {billFile ? billFile.name : "Choose recent bill"}
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    aria-label="Upload recent carrier bill PDF"
                    onChange={(e) => setBillFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setStep(2)} className={secondaryBtn}>
                ← Back
              </button>
              <button
                type="button"
                onClick={() => void submitPort()}
                disabled={busy !== null || !loaFile || !billFile}
                className={primaryBtn}
              >
                <FileCheck2 className="h-4 w-4" />
                {busy === "submit" ? "Submitting…" : "Submit port request"}
              </button>
            </div>
          </div>
        )}
      </Card>
      )}

      {requests.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-parchment mb-3">Transfer status</h2>
          <ul className="space-y-3">
            {requests.map((req) => {
              const display = byonStatusDisplay(req.status);
              const fixes = byonExceptionFixes(req.status_detail);
              return (
                <li
                  key={req.id}
                  className="rounded-lg border border-parchment/10 bg-deep-ink/40 px-3 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm text-parchment">
                        {formatDid(req.phone_e164)}
                      </span>
                      <Badge variant={display.variant}>{display.label}</Badge>
                    </div>
                    {byonCanCancel(req.status) && (
                      <button
                        type="button"
                        onClick={() => void cancelRequest(req.id)}
                        disabled={busy !== null}
                        className="text-xs text-spark-orange hover:underline disabled:opacity-40"
                      >
                        {busy === `cancel:${req.id}` ? "Cancelling…" : "Cancel"}
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-parchment/60 mt-1.5">{display.line}</p>
                  {req.foc_at && (
                    <p className="text-xs text-parchment/50 mt-1">
                      Switch date:{" "}
                      {new Date(req.foc_at).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric"
                      })}
                    </p>
                  )}
                  {fixes.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {fixes.map((fix, i) => (
                        <li key={i} className="text-[11px] text-spark-orange/90">
                          • {fix}
                        </li>
                      ))}
                    </ul>
                  )}
                  {req.support_key && (
                    <p className="text-[11px] text-parchment/35 mt-2">
                      Support reference: <span className="font-mono">{req.support_key}</span>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
