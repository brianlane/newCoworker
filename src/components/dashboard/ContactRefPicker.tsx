"use client";

/**
 * A number field that accepts EITHER a hardcoded value (E.164 / template) OR a
 * dynamic reference to a saved person — an employee from the roster or a
 * contact from the directory — whose live number is resolved at run/call time.
 *
 * The two modes are mutually exclusive (the schema's "exactly one source"
 * rules): picking a person clears the text value and vice versa. The stored
 * ref is `{ source, id, label }`; `label` is a display hint only — renames and
 * renumbers propagate automatically because resolution reads the live row.
 */

/** A pickable person (employees from the roster, contacts from the directory). */
export type PickerPerson = {
  source: "employee" | "contact";
  id: string;
  name: string;
  phone: string;
};

/** The ref shape stored on trigger/step fields (mirrors ContactRef). */
export type PickerRef = { source: "employee" | "contact"; id: string; label?: string };

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

export function ContactRefPicker({
  label,
  help,
  placeholder,
  textValue,
  refValue,
  people,
  employeesOnly = false,
  onChangeText,
  onChangeRef
}: {
  label: string;
  help?: string;
  placeholder?: string;
  /** Current hardcoded value ("" when unset). */
  textValue: string;
  /** Current saved-person reference (undefined when in text mode). */
  refValue: PickerRef | undefined;
  people: PickerPerson[];
  /** route_to_team pins a ROSTER member — contacts are not offerable agents. */
  employeesOnly?: boolean;
  onChangeText: (value: string) => void;
  /** Called with the picked ref, or undefined to switch back to text mode. */
  onChangeRef: (ref: PickerRef | undefined) => void;
}) {
  const usable = employeesOnly ? people.filter((p) => p.source === "employee") : people;
  const employees = usable.filter((p) => p.source === "employee");
  const contacts = usable.filter((p) => p.source === "contact");
  const selected = refValue ? `${refValue.source}:${refValue.id}` : "";
  // A ref saved before the person was deleted (or before the list loaded)
  // still needs a visible option so the select doesn't silently blank out.
  const selectedMissing = Boolean(refValue) && !usable.some((p) => `${p.source}:${p.id}` === selected);

  return (
    <div className="w-full">
      {label && <label className={labelClass}>{label}</label>}
      {refValue ? (
        <select
          className={inputClass}
          value={selected}
          onChange={(ev) => {
            const [source, id] = ev.target.value.split(":");
            const person = usable.find((p) => p.source === source && p.id === id);
            if (person) {
              onChangeRef({ source: person.source, id: person.id, label: person.name });
            }
          }}
        >
          {selectedMissing && (
            <option value={selected}>{refValue.label ?? "(saved contact)"}</option>
          )}
          {employees.length > 0 && (
            <optgroup label="Employees">
              {employees.map((p) => (
                <option key={`${p.source}:${p.id}`} value={`${p.source}:${p.id}`}>
                  {p.name}: {p.phone}
                </option>
              ))}
            </optgroup>
          )}
          {contacts.length > 0 && (
            <optgroup label="Contacts">
              {contacts.map((p) => (
                <option key={`${p.source}:${p.id}`} value={`${p.source}:${p.id}`}>
                  {p.name}: {p.phone}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      ) : (
        <input
          className={inputClass}
          value={textValue}
          placeholder={placeholder}
          onChange={(ev) => onChangeText(ev.target.value)}
        />
      )}
      <div className="mt-1 flex items-center gap-3">
        {refValue ? (
          <button
            type="button"
            onClick={() => onChangeRef(undefined)}
            className="text-[11px] text-signal-teal hover:underline"
          >
            Type a number instead
          </button>
        ) : (
          usable.length > 0 && (
            <button
              type="button"
              onClick={() => {
                const first = usable[0];
                onChangeRef({ source: first.source, id: first.id, label: first.name });
              }}
              className="text-[11px] text-signal-teal hover:underline"
            >
              Use a saved {employeesOnly ? "employee" : "contact"} (live number)
            </button>
          )
        )}
        {help && <p className="text-[11px] text-parchment/40">{help}</p>}
      </div>
    </div>
  );
}
