"use client";

/**
 * "New lead" for the Tasks page (all three views).
 *
 * Creates the contact through the same POST the Contacts page uses (so
 * contact_created triggers fire), then tags them into a starting stage
 * through the same tags PATCH the quick editor uses (so tag automation
 * fires and the lead is visible here). The starting tag matters: this page
 * only shows contacts with tags or active runs, so an untagged create
 * would file the lead into Contacts and show nothing here.
 *
 * `stages` is the selected pipeline's stage list where the view has one
 * (Board, Data); the List view passes null and a free-text tag is asked
 * for instead.
 */
import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { MAX_CONTACT_TAG_LENGTH } from "@/lib/customer-memory/types";

type ApiEnvelope = {
  ok?: boolean;
  data?: { customer?: { customerE164?: string } };
  error?: { message?: string };
};

export function NewLeadButton({
  businessId,
  stages,
  onCreated
}: {
  businessId: string;
  /** Stage choices (each is a tag); null when the view has no pipeline. */
  stages: { id: string; name: string }[] | null;
  onCreated: () => void;
}) {
  const t = useTranslations("dashboard.tasksData");
  // A pipeline with zero stages offers nothing to land on; fall back to the
  // free-text tag the List view uses.
  const stageChoices = stages && stages.length > 0 ? stages : null;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [stageName, setStageName] = useState<string>(stageChoices?.[0]?.name ?? "");
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the contact saved but the tag PATCH failed (rare). */
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const startingTag = (stageChoices ? stageName : tag).trim();
  const canSubmit =
    (phone.trim() !== "" || email.trim() !== "") && startingTag !== "" && !busy;

  function openDialog() {
    // Re-anchor the stage default on every open: the selected pipeline may
    // have changed since the last one.
    setStageName(stageChoices?.[0]?.name ?? "");
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setName("");
    setPhone("");
    setEmail("");
    setStageName(stageChoices?.[0]?.name ?? "");
    setTag("");
    setError(null);
    setCreatedKey(null);
    setBusy(false);
  }

  async function create() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/customers?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerE164: phone.trim(),
            email: email.trim(),
            displayName: name.trim()
          })
        }
      );
      const json = (await res.json().catch(() => null)) as ApiEnvelope | null;
      if (!res.ok || !json?.ok) {
        setError(json?.error?.message ?? t("newLeadFailed"));
        setBusy(false);
        return;
      }
      // Tag them onto the board by the server-normalized key, the same
      // replace-set write the quick editor sends (a brand-new contact has no
      // tags yet, so the set IS the one starting tag).
      const key = json.data?.customer?.customerE164;
      if (!key) {
        setError(t("newLeadFailed"));
        setBusy(false);
        return;
      }
      const tagRes = await fetch(
        `/api/dashboard/customers/${encodeURIComponent(key)}?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags: [startingTag] })
        }
      );
      const tagJson = (await tagRes.json().catch(() => null)) as ApiEnvelope | null;
      if (!tagRes.ok || !tagJson?.ok) {
        setCreatedKey(key);
        setError(t("newLeadTagFailed"));
        setBusy(false);
        return;
      }
      close();
      onCreated();
    } catch {
      setError(t("newLeadFailed"));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="new-lead"
        onClick={openDialog}
        className="inline-flex items-center gap-1.5 rounded-md bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
      >
        <Plus className="h-3.5 w-3.5" />
        {t("newLead")}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label={t("newLead")}
        >
          <div
            className="w-full max-w-md rounded-xl border border-parchment/15 bg-deep-ink p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-parchment">{t("newLead")}</h3>
              <button
                onClick={close}
                className="text-parchment/40 hover:text-parchment"
                aria-label={t("editCancel")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <label className="block text-[11px] text-parchment/60">
                {t("editName")}
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 120))}
                  placeholder={t("editNamePlaceholder")}
                  maxLength={120}
                  className="mt-1 w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1.5 text-xs text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none"
                />
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-[11px] text-parchment/60">
                  {t("newLeadPhone")}
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.slice(0, 30))}
                    placeholder="+1 602 555 0142"
                    maxLength={30}
                    className="mt-1 w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1.5 text-xs text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none"
                  />
                </label>
                <label className="block text-[11px] text-parchment/60">
                  {t("newLeadEmail")}
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value.slice(0, 254))}
                    placeholder="lead@example.com"
                    maxLength={254}
                    className="mt-1 w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1.5 text-xs text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none"
                  />
                </label>
              </div>
              <p className="text-[10px] text-parchment/40">{t("newLeadIdentity")}</p>

              {stageChoices ? (
                <label className="block text-[11px] text-parchment/60">
                  {t("colStage")}
                  <select
                    value={stageName}
                    onChange={(e) => setStageName(e.target.value)}
                    className="mt-1 w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1.5 text-xs text-parchment focus:border-claw-green/60 focus:outline-none"
                  >
                    {stageChoices.map((s) => (
                      <option key={s.id} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="block text-[11px] text-parchment/60">
                  {t("newLeadTag")}
                  <input
                    type="text"
                    value={tag}
                    onChange={(e) => setTag(e.target.value.slice(0, MAX_CONTACT_TAG_LENGTH))}
                    placeholder={t("newLeadTagPlaceholder")}
                    maxLength={MAX_CONTACT_TAG_LENGTH}
                    className="mt-1 w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1.5 text-xs text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none"
                  />
                  <span className="mt-1 block text-[10px] text-parchment/40">
                    {t("newLeadTagHelp")}
                  </span>
                </label>
              )}

              {error && (
                <p className="text-xs text-spark-orange">
                  {error}
                  {createdKey && (
                    <>
                      {" "}
                      <Link
                        href={`/dashboard/customers/${encodeURIComponent(createdKey)}`}
                        className="text-signal-teal hover:underline"
                      >
                        {t("editFullProfile")}
                      </Link>
                    </>
                  )}
                </p>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="new-lead-save"
                  onClick={() => void create()}
                  disabled={!canSubmit}
                  className="rounded-md bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? t("newLeadCreating") : t("newLeadCreate")}
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment"
                >
                  {t("editCancel")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
