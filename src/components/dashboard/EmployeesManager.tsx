"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import type {
  EmployeeRoutingStats,
  TeamMemberRow,
  TimeOffRow
} from "@/lib/db/employees";
import { formatScheduleText } from "@/lib/employees/schedule-text";

type Props = {
  businessId: string;
  initialMembers: TeamMemberRow[];
  initialTimeOff: TimeOffRow[];
  initialStats: Record<string, EmployeeRoutingStats>;
};

type ApiError = { error?: { message?: string } };

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as ApiError | null;
  return json?.error?.message || `HTTP ${res.status}`;
}

/** Today's date as YYYY-MM-DD in the browser's timezone (form defaults only). */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function EmployeesManager(props: Props) {
  const [members, setMembers] = useState(props.initialMembers);
  const [timeOff, setTimeOff] = useState(props.initialTimeOff);
  const [stats, setStats] = useState(props.initialStats);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Add form
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [adding, setAdding] = useState(false);

  const qs = `businessId=${encodeURIComponent(props.businessId)}`;

  async function refresh() {
    const res = await fetch(`/api/dashboard/employees?${qs}`, { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as {
      ok: boolean;
      data?: {
        members: TeamMemberRow[];
        timeOff: TimeOffRow[];
        stats: Record<string, EmployeeRoutingStats>;
      };
    };
    if (json.ok && json.data) {
      setMembers(json.data.members);
      setTimeOff(json.data.timeOff);
      setStats(json.data.stats);
    }
  }

  async function addMember() {
    setAdding(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/dashboard/employees?${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: addName.trim(),
          phoneE164: addPhone.trim(),
          ...(addEmail.trim() ? { email: addEmail.trim() } : {})
        })
      });
      if (!res.ok) throw new Error(await readError(res));
      setAddName("");
      setAddPhone("");
      setAddEmail("");
      setAddOpen(false);
      await refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-parchment">
          Roster ({members.length})
        </h2>
        {!addOpen && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors"
          >
            Add employee
          </button>
        )}
      </div>

      {errorMsg && <p className="text-xs text-red-300">{errorMsg}</p>}

      {addOpen && (
        <Card>
          <h3 className="text-sm font-semibold text-parchment mb-3">New employee</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <input
              type="text"
              value={addName}
              onChange={(e) => setAddName(e.target.value.slice(0, 120))}
              placeholder="Name"
              className="bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
            />
            <input
              type="tel"
              value={addPhone}
              onChange={(e) => setAddPhone(e.target.value.slice(0, 16))}
              placeholder="+16025551234"
              className="bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60 font-mono"
            />
            <input
              type="email"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value.slice(0, 254))}
              placeholder="Email (optional)"
              className="bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
            />
          </div>
          <div className="flex items-center gap-3 mt-3">
            <button
              type="button"
              onClick={addMember}
              disabled={adding || !addName.trim() || !addPhone.trim()}
              className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {adding ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              disabled={adding}
              className="rounded-lg border border-parchment/20 text-parchment/70 px-4 py-2 text-sm hover:bg-parchment/5 transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </Card>
      )}

      {members.length === 0 && !addOpen ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No employees yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              Add your team so lead-routing flows can offer them new leads in
              rotation.
            </p>
          </div>
        </Card>
      ) : (
        members.map((m) => (
          <EmployeeCard
            key={m.id}
            member={m}
            timeOff={timeOff.filter((t) => t.member_id === m.id)}
            stats={stats[m.phone_e164] ?? null}
            qs={qs}
            onChanged={refresh}
            onError={setErrorMsg}
          />
        ))
      )}
    </div>
  );
}

function EmployeeCard({
  member,
  timeOff,
  stats,
  qs,
  onChanged,
  onError
}: {
  member: TeamMemberRow;
  timeOff: TimeOffRow[];
  stats: EmployeeRoutingStats | null;
  qs: string;
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  // Edit fields (seeded when the panel opens)
  const [name, setName] = useState(member.name);
  const [phone, setPhone] = useState(member.phone_e164);
  const [email, setEmail] = useState(member.email ?? "");
  const [scheduleText, setScheduleText] = useState(formatScheduleText(member.weekly_schedule));
  const [preferredText, setPreferredText] = useState(
    formatScheduleText(member.preferred_windows)
  );

  // Time-off add form
  const [tooStart, setTooStart] = useState(todayIso());
  const [tooEnd, setTooEnd] = useState(todayIso());
  const [tooNote, setTooNote] = useState("");

  const today = todayIso();
  const claimRate =
    stats && stats.offered > 0 ? Math.round((stats.claimed / stats.offered) * 100) : null;

  async function call(path: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(path, init);
      if (!res.ok) throw new Error(await readError(res));
      await onChanged();
      return true;
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    const ok = await call(`/api/dashboard/employees/${member.id}?${qs}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        phoneE164: phone.trim(),
        email: email.trim() ? email.trim() : null,
        scheduleText,
        preferredText
      })
    });
    if (ok) setEditing(false);
  }

  async function toggleActive() {
    await call(`/api/dashboard/employees/${member.id}?${qs}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !member.active })
    });
  }

  async function remove() {
    const ok = window.confirm(
      `Remove ${member.name} from the roster?\n\nThey stop receiving lead offers immediately and their time-off entries are removed. Past routing history is kept.`
    );
    if (!ok) return;
    await call(`/api/dashboard/employees/${member.id}?${qs}`, { method: "DELETE" });
  }

  async function addTimeOff() {
    const ok = await call(`/api/dashboard/employees/${member.id}/time-off?${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startsOn: tooStart,
        endsOn: tooEnd,
        ...(tooNote.trim() ? { note: tooNote.trim() } : {})
      })
    });
    if (ok) setTooNote("");
  }

  async function removeTimeOff(id: string) {
    await call(
      `/api/dashboard/employees/${member.id}/time-off?${qs}&timeOffId=${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }

  const outNow = timeOff.some((t) => t.starts_on <= today && t.ends_on >= today);
  const upcoming = timeOff.filter((t) => t.ends_on >= today);

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-parchment">{member.name}</span>
            <span className="text-xs text-parchment/50 font-mono">{member.phone_e164}</span>
            {member.email && (
              <span className="text-xs text-parchment/50">{member.email}</span>
            )}
            {!member.active && (
              <span className="text-[10px] uppercase tracking-wide text-parchment/60 bg-parchment/10 rounded px-1.5 py-0.5">
                inactive
              </span>
            )}
            {outNow && (
              <span className="text-[10px] uppercase tracking-wide text-spark-orange bg-spark-orange/10 rounded px-1.5 py-0.5">
                out today
              </span>
            )}
          </div>
          <p className="text-[11px] text-parchment/50 mt-1">
            {stats
              ? `${stats.offered} lead offer${stats.offered === 1 ? "" : "s"} • ${stats.claimed} claimed${claimRate !== null ? ` (${claimRate}%)` : ""}`
              : "No lead offers yet"}
            {stats?.lastClaimedAt && (
              <>
                {" • last claim "}
                <LocalDateTime iso={stats.lastClaimedAt} />
              </>
            )}
          </p>
          {!editing && (
            <p className="text-[11px] text-parchment/40 mt-0.5">
              {formatScheduleText(member.weekly_schedule)
                ? `Works ${formatScheduleText(member.weekly_schedule)}`
                : "No schedule — always available"}
              {formatScheduleText(member.preferred_windows) &&
                ` • prefers ${formatScheduleText(member.preferred_windows)}`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            disabled={busy}
            className="rounded-lg border border-parchment/20 text-parchment/80 px-3 py-1.5 text-xs hover:bg-parchment/5 transition-colors disabled:opacity-40"
          >
            {editing ? "Close" : "Edit"}
          </button>
          <button
            type="button"
            onClick={toggleActive}
            disabled={busy}
            className="rounded-lg border border-parchment/20 text-parchment/80 px-3 py-1.5 text-xs hover:bg-parchment/5 transition-colors disabled:opacity-40"
          >
            {member.active ? "Deactivate" : "Activate"}
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-4 space-y-3 border-t border-parchment/10 pt-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-parchment/70">
              Name
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 120))}
                className="mt-1 w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment focus:outline-none focus:border-claw-green/60"
              />
            </label>
            <label className="text-xs text-parchment/70">
              Phone (E.164)
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value.slice(0, 16))}
                className="mt-1 w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment font-mono focus:outline-none focus:border-claw-green/60"
              />
            </label>
            <label className="text-xs text-parchment/70">
              Email <span className="text-parchment/40">(optional)</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value.slice(0, 254))}
                className="mt-1 w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment focus:outline-none focus:border-claw-green/60"
              />
            </label>
          </div>
          <label className="block text-xs text-parchment/70">
            Weekly schedule{" "}
            <span className="text-parchment/40">
              (optional — outside these hours they aren&apos;t offered leads)
            </span>
            <input
              type="text"
              value={scheduleText}
              onChange={(e) => setScheduleText(e.target.value.slice(0, 500))}
              placeholder='e.g. "mon-fri 09:00-17:00; sat 10:00-14:00"'
              className="mt-1 w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 font-mono focus:outline-none focus:border-claw-green/60"
            />
          </label>
          <label className="block text-xs text-parchment/70">
            Preferred lead times{" "}
            <span className="text-parchment/40">
              (optional — bumps them to the front of the rotation during these hours)
            </span>
            <input
              type="text"
              value={preferredText}
              onChange={(e) => setPreferredText(e.target.value.slice(0, 500))}
              placeholder='e.g. "mon-fri 09:00-12:00"'
              className="mt-1 w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 font-mono focus:outline-none focus:border-claw-green/60"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={saveEdit}
              disabled={busy || !name.trim() || !phone.trim()}
              className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="rounded-lg border border-red-400/40 text-red-300 px-4 py-2 text-sm hover:bg-red-400/10 transition-colors disabled:opacity-40"
            >
              Remove from roster
            </button>
          </div>

          <div className="border-t border-parchment/10 pt-3">
            <h4 className="text-xs font-semibold text-parchment mb-2">Time off</h4>
            {upcoming.length > 0 && (
              <ul className="space-y-1 mb-3">
                {upcoming.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 text-xs text-parchment/70">
                    <span className="font-mono">
                      {t.starts_on === t.ends_on ? t.starts_on : `${t.starts_on} → ${t.ends_on}`}
                    </span>
                    {t.note && <span className="text-parchment/50">{t.note}</span>}
                    <button
                      type="button"
                      onClick={() => removeTimeOff(t.id)}
                      disabled={busy}
                      className="text-red-300/80 hover:text-red-300 transition-colors disabled:opacity-40"
                      title="Remove time off"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-[11px] text-parchment/60">
                From
                <input
                  type="date"
                  value={tooStart}
                  onChange={(e) => setTooStart(e.target.value)}
                  className="mt-0.5 block bg-deep-ink/60 border border-parchment/15 rounded-lg px-2 py-1.5 text-xs text-parchment focus:outline-none focus:border-claw-green/60"
                />
              </label>
              <label className="text-[11px] text-parchment/60">
                Through
                <input
                  type="date"
                  value={tooEnd}
                  onChange={(e) => setTooEnd(e.target.value)}
                  className="mt-0.5 block bg-deep-ink/60 border border-parchment/15 rounded-lg px-2 py-1.5 text-xs text-parchment focus:outline-none focus:border-claw-green/60"
                />
              </label>
              <input
                type="text"
                value={tooNote}
                onChange={(e) => setTooNote(e.target.value.slice(0, 300))}
                placeholder="Note (optional)"
                className="flex-1 min-w-[8rem] bg-deep-ink/60 border border-parchment/15 rounded-lg px-2 py-1.5 text-xs text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
              />
              <button
                type="button"
                onClick={addTimeOff}
                disabled={busy || !tooStart || !tooEnd || tooEnd < tooStart}
                className="rounded-lg border border-parchment/20 text-parchment/80 px-3 py-1.5 text-xs hover:bg-parchment/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Add time off
              </button>
            </div>
            <p className="text-[10px] text-parchment/40 mt-2">
              Time off always wins: an employee who is out today is skipped by
              lead routing even when a flow is pinned directly to them.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
