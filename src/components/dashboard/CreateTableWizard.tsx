"use client";

/**
 * Three steps to a new table, in the owner's language.
 *
 * Step zero offers templates because "add a column" from nothing is the
 * highest drop-off point for someone who does not think in schemas. Every
 * template only pre-fills the steps; nothing is locked afterwards.
 *
 * The word "foreign key" appears nowhere. Step 2 asks whether each row is
 * about one of your contacts, which is the same question in the language of
 * the person answering it.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import {
  MAX_FIELDS_PER_TABLE,
  MAX_TABLE_NAME_LENGTH,
  type CustomTableFieldType,
  type CustomTableIcon,
  type CustomTableRowLink
} from "@/lib/custom-tables/types";
import { fieldHasOptions } from "@/lib/custom-tables/core";

type Props = { businessId: string };

type Draft = { label: string; type: CustomTableFieldType; options: string };

type ApiEnvelope<T> = { ok: boolean; data?: T; error?: { message?: string } };

async function readEnvelope<T>(res: Response): Promise<T> {
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok || !json.data) {
    throw new Error(json.error?.message ?? "Request failed");
  }
  return json.data;
}

/** Static key map, never a computed one: the i18n usage test reads literals. */
const TYPE_LABEL_KEY = {
  text: "typeText",
  long_text: "typeLongText",
  number: "typeNumber",
  date: "typeDate",
  checkbox: "typeCheckbox",
  select: "typeSelect",
  multi_select: "typeMultiSelect"
} as const;

const TYPE_HELP_KEY = {
  text: "typeTextHelp",
  long_text: "typeLongTextHelp",
  number: "typeNumberHelp",
  date: "typeDateHelp",
  checkbox: "typeCheckboxHelp",
  select: "typeSelectHelp",
  multi_select: "typeMultiSelectHelp"
} as const;

const TYPES = Object.keys(TYPE_LABEL_KEY) as CustomTableFieldType[];

/**
 * The shapes small businesses actually keep, which is also the set
 * GoHighLevel ships. Labels stay English here on purpose: they become the
 * owner's own column names the moment they hit Create, and tenant content is
 * never translated.
 */
const TEMPLATES = [
  {
    key: "scratch" as const,
    titleKey: "templateScratch" as const,
    blurbKey: "templateScratchBlurb" as const,
    icon: "table" as CustomTableIcon,
    name: "",
    rowLink: "standalone" as CustomTableRowLink,
    fields: [{ label: "Name", type: "text" as const, options: "" }]
  },
  {
    key: "properties" as const,
    titleKey: "templateProperties" as const,
    blurbKey: "templatePropertiesBlurb" as const,
    icon: "home" as CustomTableIcon,
    name: "Properties",
    rowLink: "standalone" as CustomTableRowLink,
    fields: [
      { label: "Name", type: "text" as const, options: "" },
      { label: "Address", type: "text" as const, options: "" },
      { label: "Price", type: "number" as const, options: "" },
      { label: "Status", type: "select" as const, options: "Available, Under contract, Sold" },
      { label: "Notes", type: "long_text" as const, options: "" }
    ]
  },
  {
    key: "vehicles" as const,
    titleKey: "templateVehicles" as const,
    blurbKey: "templateVehiclesBlurb" as const,
    icon: "truck" as CustomTableIcon,
    name: "Vehicles",
    rowLink: "contact" as CustomTableRowLink,
    fields: [
      { label: "Name", type: "text" as const, options: "" },
      { label: "Make and model", type: "text" as const, options: "" },
      { label: "Serial or VIN", type: "text" as const, options: "" },
      { label: "Last serviced", type: "date" as const, options: "" },
      { label: "Notes", type: "long_text" as const, options: "" }
    ]
  },
  {
    key: "policies" as const,
    titleKey: "templatePolicies" as const,
    blurbKey: "templatePoliciesBlurb" as const,
    icon: "shield" as CustomTableIcon,
    name: "Policies",
    rowLink: "contact" as CustomTableRowLink,
    fields: [
      { label: "Name", type: "text" as const, options: "" },
      { label: "Plan", type: "text" as const, options: "" },
      { label: "Starts", type: "date" as const, options: "" },
      { label: "Renews", type: "date" as const, options: "" },
      { label: "Amount", type: "number" as const, options: "" }
    ]
  },
  {
    key: "inventory" as const,
    titleKey: "templateInventory" as const,
    blurbKey: "templateInventoryBlurb" as const,
    icon: "package" as CustomTableIcon,
    name: "Inventory",
    rowLink: "standalone" as CustomTableRowLink,
    fields: [
      { label: "Name", type: "text" as const, options: "" },
      { label: "SKU", type: "text" as const, options: "" },
      { label: "On hand", type: "number" as const, options: "" },
      { label: "Reorder at", type: "number" as const, options: "" },
      { label: "Notes", type: "long_text" as const, options: "" }
    ]
  }
];

export function CreateTableWizard({ businessId }: Props) {
  const t = useTranslations("dashboard.tables");
  const router = useRouter();
  const [templateKey, setTemplateKey] = useState<string>("scratch");
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<CustomTableIcon>("table");
  const [rowLink, setRowLink] = useState<CustomTableRowLink>("standalone");
  const [fields, setFields] = useState<Draft[]>([{ label: "Name", type: "text", options: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickTemplate = (key: string) => {
    const template = TEMPLATES.find((tpl) => tpl.key === key) ?? TEMPLATES[0];
    setTemplateKey(key);
    setName(template.name);
    setIcon(template.icon);
    setRowLink(template.rowLink);
    setFields(template.fields.map((f) => ({ ...f })));
  };

  const setField = (index: number, patch: Partial<Draft>) => {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        icon,
        rowLink,
        fields: fields
          .filter((f) => f.label.trim().length > 0)
          .map((f) => ({
            label: f.label.trim(),
            type: f.type,
            ...(fieldHasOptions(f.type)
              ? {
                  options: f.options
                    .split(",")
                    .map((o) => o.trim())
                    .filter((o) => o.length > 0)
                }
              : {})
          }))
      };
      const data = await fetch(
        `/api/dashboard/custom-tables?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      ).then((r) => readEnvelope<{ table: { id: string } }>(r));
      router.push(`/dashboard/tables/${data.table.id}?created=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("newFailed"));
      setBusy(false);
    }
  };

  const named = fields.filter((f) => f.label.trim().length > 0);
  // Every choice column needs at least two options, so the server would
  // refuse anyway. Saying so here means the owner is not told after typing
  // the whole table out.
  const choiceIncomplete = named.some(
    (f) =>
      fieldHasOptions(f.type) &&
      f.options.split(",").map((o) => o.trim()).filter(Boolean).length < 2
  );
  const canCreate = name.trim().length > 0 && named.length > 0 && !choiceIncomplete && !busy;

  return (
    <Card className="space-y-8">
      {error && <p className="text-sm text-spark-orange">{error}</p>}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-parchment">{t("templatePickTitle")}</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.key}
              type="button"
              onClick={() => pickTemplate(tpl.key)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                templateKey === tpl.key
                  ? "border-signal-teal/60 bg-signal-teal/10"
                  : "border-parchment/15 hover:border-parchment/30"
              }`}
            >
              <span className="block text-sm font-medium text-parchment">{t(tpl.titleKey)}</span>
              <span className="mt-1 block text-xs text-parchment/50">{t(tpl.blurbKey)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-parchment">{t("newStepName")}</h2>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("newNamePlaceholder")}
          maxLength={MAX_TABLE_NAME_LENGTH}
          className="w-full max-w-sm rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30"
        />
        <p className="text-xs text-parchment/40">{t("newStepNameHelp")}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-parchment">{t("newStepLink")}</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["standalone", "contact"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setRowLink(mode)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                rowLink === mode
                  ? "border-signal-teal/60 bg-signal-teal/10"
                  : "border-parchment/15 hover:border-parchment/30"
              }`}
            >
              <span className="block text-sm font-medium text-parchment">
                {mode === "standalone" ? t("newLinkStandalone") : t("newLinkContact")}
              </span>
              <span className="mt-1 block text-xs text-parchment/50">
                {mode === "standalone" ? t("newLinkStandaloneHelp") : t("newLinkContactHelp")}
              </span>
            </button>
          ))}
        </div>
        <p className="text-xs text-parchment/40">{t("newLinkChangeNote")}</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-parchment">{t("newStepColumns")}</h2>
        <div className="space-y-2">
          {fields.map((field, index) => (
            <div key={index} className="space-y-1.5 rounded-lg border border-parchment/10 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={field.label}
                  onChange={(e) => setField(index, { label: e.target.value })}
                  placeholder={t("newColumnName")}
                  maxLength={60}
                  className="w-44 rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-sm text-parchment placeholder:text-parchment/30"
                />
                <select
                  value={field.type}
                  onChange={(e) =>
                    setField(index, { type: e.target.value as CustomTableFieldType })
                  }
                  aria-label={t("newColumnType")}
                  className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-sm text-parchment"
                >
                  {TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(TYPE_LABEL_KEY[type])}
                    </option>
                  ))}
                </select>
                {fields.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setFields((prev) => prev.filter((_, i) => i !== index))}
                    aria-label={t("newRemoveColumn", { label: field.label || t("newColumnName") })}
                    className="text-parchment/40 hover:text-parchment"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              <p className="text-[11px] text-parchment/40">{t(TYPE_HELP_KEY[field.type])}</p>
              {fieldHasOptions(field.type) && (
                <div>
                  <input
                    value={field.options}
                    onChange={(e) => setField(index, { options: e.target.value })}
                    placeholder={t("optionsPlaceholder")}
                    aria-label={t("optionsLabel")}
                    className="w-full max-w-md rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-sm text-parchment placeholder:text-parchment/30"
                  />
                  <p className="mt-1 text-[11px] text-parchment/40">{t("optionsHelp")}</p>
                </div>
              )}
            </div>
          ))}
        </div>
        {fields.length < MAX_FIELDS_PER_TABLE && (
          <button
            type="button"
            onClick={() => setFields((prev) => [...prev, { label: "", type: "text", options: "" }])}
            className="inline-flex items-center gap-1 rounded-md border border-parchment/15 px-2.5 py-1 text-xs text-parchment/70 hover:text-parchment"
          >
            <Plus className="h-3 w-3" />
            {t("newAddColumn")}
          </button>
        )}
      </section>

      <div className="flex items-center gap-2 border-t border-parchment/10 pt-4">
        <button
          type="button"
          onClick={() => void create()}
          disabled={!canCreate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-50"
        >
          {busy ? t("newCreating") : t("newCreate")}
        </button>
        <button
          type="button"
          onClick={() => router.push("/dashboard/tables")}
          className="rounded-lg border border-parchment/15 px-4 py-2 text-sm text-parchment/70 hover:text-parchment"
        >
          {t("newCancel")}
        </button>
      </div>
    </Card>
  );
}
