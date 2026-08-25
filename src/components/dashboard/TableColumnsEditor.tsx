"use client";

/**
 * The schema panel: rename the table, add and edit columns, delete either.
 *
 * A distinct MODE rather than something mixed into the grid, which is the
 * lesson worth keeping from Salesforce's Object Manager: an owner should
 * never be one mis-click from renaming a column while typing into a cell.
 * The panel replaces the toolbar and the grid dims behind it.
 *
 * A column's TYPE is deliberately not editable. Changing it would mean
 * migrating every row's value with no transaction available, so the owner
 * deletes the column and adds a new one, which makes the data loss explicit
 * instead of silent.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { fieldHasOptions } from "@/lib/custom-tables/core";
import {
  CUSTOM_TABLE_TRASH_RETENTION_DAYS,
  MAX_FIELD_LABEL_LENGTH,
  MAX_FIELDS_PER_TABLE,
  MAX_TABLE_NAME_LENGTH,
  type CustomTable,
  type CustomTableFieldType
} from "@/lib/custom-tables/types";

type Props = {
  table: CustomTable;
  busy: boolean;
  onPatch: (body: Record<string, unknown>) => Promise<boolean>;
  onRename: (name: string) => Promise<boolean>;
  onDeleteTable: () => void;
};

const TYPE_LABEL_KEY = {
  text: "typeText",
  long_text: "typeLongText",
  number: "typeNumber",
  date: "typeDate",
  checkbox: "typeCheckbox",
  select: "typeSelect",
  multi_select: "typeMultiSelect"
} as const;

const TYPES = Object.keys(TYPE_LABEL_KEY) as CustomTableFieldType[];

export function TableColumnsEditor({ table, busy, onPatch, onRename, onDeleteTable }: Props) {
  const t = useTranslations("dashboard.tables");
  const [name, setName] = useState(table.name);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<CustomTableFieldType>("text");
  const [newOptions, setNewOptions] = useState("");

  const move = (index: number, delta: number) => {
    const ids = table.fields.map((f) => f.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void onPatch({ action: "reorder_fields", fieldIds: ids });
  };

  const parseOptions = (raw: string) =>
    raw
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-parchment/50">
          {t("schemaRenameTableLabel")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_TABLE_NAME_LENGTH}
            className="mt-1 block w-56 rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-sm text-parchment"
          />
        </label>
        <button
          type="button"
          onClick={() => void onRename(name)}
          disabled={busy || name.trim() === table.name || name.trim().length === 0}
          className="rounded-md border border-parchment/15 px-2.5 py-1 text-xs text-parchment/70 hover:text-parchment disabled:opacity-40"
        >
          {busy ? t("schemaSaving") : t("schemaRename")}
        </button>
      </div>

      <div className="space-y-2 border-t border-parchment/10 pt-3">
        {table.fields.map((field, index) => (
          <div key={field.id} className="space-y-1.5 rounded-lg border border-parchment/10 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={labels[field.id] ?? field.label}
                onChange={(e) => setLabels((p) => ({ ...p, [field.id]: e.target.value }))}
                onBlur={() => {
                  const next = (labels[field.id] ?? field.label).trim();
                  if (!next || next === field.label) return;
                  void onPatch({ action: "update_field", fieldId: field.id, label: next });
                }}
                maxLength={MAX_FIELD_LABEL_LENGTH}
                aria-label={field.label}
                className="w-44 rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-sm text-parchment"
              />
              <span
                className="rounded-md border border-parchment/10 px-2 py-1 text-xs text-parchment/40"
                title={t("schemaTypeLocked")}
              >
                {t(TYPE_LABEL_KEY[field.type])}
              </span>
              <label className="flex items-center gap-1 text-xs text-parchment/50">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(e) =>
                    void onPatch({
                      action: "update_field",
                      fieldId: field.id,
                      required: e.target.checked
                    })
                  }
                  className="h-3.5 w-3.5 accent-signal-teal"
                />
                {t("schemaRequired")}
              </label>
              <label className="flex items-center gap-1 text-xs text-parchment/50">
                <input
                  type="checkbox"
                  checked={!field.enabled}
                  onChange={(e) =>
                    void onPatch({
                      action: "update_field",
                      fieldId: field.id,
                      enabled: !e.target.checked
                    })
                  }
                  className="h-3.5 w-3.5 accent-signal-teal"
                />
                {t("schemaPaused")}
              </label>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={busy || index === 0}
                  aria-label={t("schemaMoveUp", { label: field.label })}
                  className="text-parchment/40 hover:text-parchment disabled:opacity-25"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={busy || index === table.fields.length - 1}
                  aria-label={t("schemaMoveDown", { label: field.label })}
                  className="text-parchment/40 hover:text-parchment disabled:opacity-25"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!window.confirm(t("schemaDeleteColumnConfirm", { label: field.label }))) {
                      return;
                    }
                    void onPatch({ action: "delete_field", fieldId: field.id });
                  }}
                  disabled={busy}
                  aria-label={t("schemaDeleteColumn", { label: field.label })}
                  className="text-parchment/40 hover:text-spark-orange disabled:opacity-25"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            {fieldHasOptions(field.type) && (
              <input
                value={optionDrafts[field.id] ?? (field.options ?? []).join(", ")}
                onChange={(e) => setOptionDrafts((p) => ({ ...p, [field.id]: e.target.value }))}
                onBlur={() => {
                  const draft = optionDrafts[field.id];
                  if (draft === undefined) return;
                  const options = parseOptions(draft);
                  if (options.join(",") === (field.options ?? []).join(",")) return;
                  void onPatch({ action: "update_field", fieldId: field.id, options });
                }}
                aria-label={t("optionsLabel")}
                className="w-full max-w-md rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-xs text-parchment"
              />
            )}
          </div>
        ))}
      </div>

      {table.fields.length < MAX_FIELDS_PER_TABLE && (
        <div className="flex flex-wrap items-center gap-2 border-t border-parchment/10 pt-3">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={t("newColumnName")}
            maxLength={MAX_FIELD_LABEL_LENGTH}
            className="w-44 rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-sm text-parchment placeholder:text-parchment/30"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as CustomTableFieldType)}
            aria-label={t("newColumnType")}
            className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-sm text-parchment"
          >
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {t(TYPE_LABEL_KEY[type])}
              </option>
            ))}
          </select>
          {fieldHasOptions(newType) && (
            <input
              value={newOptions}
              onChange={(e) => setNewOptions(e.target.value)}
              placeholder={t("optionsPlaceholder")}
              aria-label={t("optionsLabel")}
              className="w-56 rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1 text-sm text-parchment placeholder:text-parchment/30"
            />
          )}
          <button
            type="button"
            onClick={async () => {
              const ok = await onPatch({
                action: "add_field",
                field: {
                  label: newLabel.trim(),
                  type: newType,
                  ...(fieldHasOptions(newType) ? { options: parseOptions(newOptions) } : {})
                }
              });
              if (ok) {
                setNewLabel("");
                setNewOptions("");
              }
            }}
            disabled={
              busy ||
              newLabel.trim().length === 0 ||
              (fieldHasOptions(newType) && parseOptions(newOptions).length < 2)
            }
            className="inline-flex items-center gap-1 rounded-md border border-parchment/15 px-2.5 py-1 text-xs text-parchment/70 hover:text-parchment disabled:opacity-40"
          >
            <Plus className="h-3 w-3" />
            {t("schemaAddColumn")}
          </button>
        </div>
      )}

      <div className="border-t border-parchment/10 pt-3">
        <button
          type="button"
          onClick={() => {
            if (
              !window.confirm(
                t("schemaDeleteTableConfirm", {
                  name: table.name,
                  days: CUSTOM_TABLE_TRASH_RETENTION_DAYS
                })
              )
            ) {
              return;
            }
            onDeleteTable();
          }}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-spark-orange/30 px-2.5 py-1 text-xs text-spark-orange/80 hover:text-spark-orange disabled:opacity-40"
        >
          <Trash2 className="h-3 w-3" />
          {t("schemaDeleteTable")}
        </button>
      </div>
    </Card>
  );
}
