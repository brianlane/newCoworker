"use client";

/**
 * Team access card (enterprise): invite additional logins with roles,
 * change roles, revoke access. Talks to /api/dashboard/team; the server
 * enforces the enterprise tier gate and the manage_team permission — this
 * card is rendered for enterprise businesses only, but nothing here is
 * trusted.
 */

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import type { MemberRole } from "@/lib/authz/policy";

export type TeamMemberView = {
  id: string;
  email: string;
  role: MemberRole;
  status: "invited" | "active" | "revoked";
  created_at: string;
  employee_id: string | null;
};

export type EmployeeOption = { id: string; name: string };

const ROLE_LABEL: Record<MemberRole, string> = {
  manager: "Manager — settings, AiFlows, team",
  staff: "Staff — dashboard, messages, calls"
};

export function TeamAccessManager({
  businessId,
  initialMembers,
  employees
}: {
  businessId: string;
  initialMembers: TeamMemberView[];
  /** ai_flow_team_members roster for the optional person-profile link. */
  employees: EmployeeOption[];
}) {
  const [members, setMembers] = useState<TeamMemberView[]>(initialMembers);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("staff");
  const [employeeId, setEmployeeId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch(`/api/dashboard/team?businessId=${businessId}`);
    const json = await res.json();
    if (res.ok) setMembers(json.data?.members ?? []);
  }

  async function invite() {
    if (!email.trim()) {
      setError("Enter the teammate's email");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/dashboard/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          email: email.trim(),
          role,
          ...(employeeId ? { employeeId } : {})
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Invite failed");
      } else {
        const delivery = json.data?.delivery as string | undefined;
        setNotice(
          delivery === "auth_invite"
            ? "Invited — they'll get an email with a link to set their password."
            : delivery === "notice_email"
              ? "Added — they already have a login and were emailed a heads-up."
              : "Added — email couldn't be sent automatically, so let them know to sign in with that address."
        );
        setEmail("");
        setEmployeeId("");
        await refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function changeRole(memberId: string, nextRole: MemberRole) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/team", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, memberId, role: nextRole })
      });
      const json = await res.json();
      if (!res.ok) setError(json.error?.message ?? "Role change failed");
      await refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function revoke(memberId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/team", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, memberId })
      });
      const json = await res.json();
      if (!res.ok) setError(json.error?.message ?? "Revoke failed");
      await refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  const visible = members.filter((m) => m.status !== "revoked");
  const inputCls =
    "rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5";

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-2">Team access</h2>
      <p className="text-xs text-parchment/40 mb-4">
        Give teammates their own login. Managers can run settings, AiFlows, and the team;
        staff can work the dashboard. Billing stays with the owner.
      </p>

      <div className="flex flex-wrap items-end gap-2 mb-3">
        <label className="flex flex-col gap-1 text-xs text-parchment/60">
          Email
          <input
            className={`${inputCls} w-64`}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            type="email"
            maxLength={320}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-parchment/60">
          Role
          <select
            className={inputCls}
            value={role}
            onChange={(e) => setRole(e.target.value as MemberRole)}
          >
            {(Object.keys(ROLE_LABEL) as MemberRole[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        {employees.length > 0 && (
          <label className="flex flex-col gap-1 text-xs text-parchment/60">
            Link to employee (optional)
            <select
              className={inputCls}
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              <option value="">No link</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button size="sm" onClick={invite} disabled={loading}>
          {loading ? "Working…" : "Invite"}
        </Button>
      </div>

      {error && <p className="text-xs text-spark-orange mb-2">{error}</p>}
      {notice && <p className="text-xs text-claw-green mb-2">{notice}</p>}

      {visible.length === 0 ? (
        <p className="text-xs text-parchment/40">No team members yet — just the owner.</p>
      ) : (
        <ul className="space-y-1.5">
          {visible.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm text-parchment truncate">{m.email}</p>
                <p className="text-xs text-parchment/40">
                  {m.status === "invited" ? "Invited — hasn't signed in yet" : "Active"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <select
                  className={inputCls}
                  value={m.role}
                  onChange={(e) => changeRole(m.id, e.target.value as MemberRole)}
                  disabled={loading}
                >
                  <option value="manager">Manager</option>
                  <option value="staff">Staff</option>
                </select>
                <Button size="sm" variant="ghost" onClick={() => revoke(m.id)} disabled={loading}>
                  Revoke
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
