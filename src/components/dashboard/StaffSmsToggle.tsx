"use client";

/**
 * Staff SMS behavior.
 *
 * Controls what happens when the OWNER or a roster team member texts the
 * business number (detected by the same numbers Safe Mode uses):
 *   - "Reply as assistant" — the assistant answers them in internal-assistant
 *     mode (no lead intake, no customer profile), like the dashboard chat.
 *   - "Forward to owner" — also relay the text to the owner's cell.
 *
 * Both persist to business_telnyx_settings via /api/business/staff-sms.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { parseEnvelope } from "@/lib/client/api-envelope";

type Props = {
  businessId: string;
  initialAssistantReplyEnabled: boolean;
  initialForwardToOwnerEnabled: boolean;
};

export function StaffSmsToggle({
  businessId,
  initialAssistantReplyEnabled,
  initialForwardToOwnerEnabled
}: Props) {
  const router = useRouter();
  const [assistantReply, setAssistantReply] = useState(initialAssistantReplyEnabled);
  const [forwardToOwner, setForwardToOwner] = useState(initialForwardToOwnerEnabled);
  const [saving, setSaving] = useState<null | "reply" | "forward">(null);
  const [error, setError] = useState<string | null>(null);

  async function save(
    field: "reply" | "forward",
    patch: { assistantReplyEnabled?: boolean; forwardToOwnerEnabled?: boolean }
  ) {
    setError(null);
    setSaving(field);
    // Optimistic: reflect the click immediately, roll back on failure.
    if (patch.assistantReplyEnabled !== undefined) setAssistantReply(patch.assistantReplyEnabled);
    if (patch.forwardToOwnerEnabled !== undefined) setForwardToOwner(patch.forwardToOwnerEnabled);
    try {
      const res = await fetch("/api/business/staff-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, ...patch })
      });
      const env = await parseEnvelope<{
        assistantReplyEnabled: boolean;
        forwardToOwnerEnabled: boolean;
      }>(res);
      if (!env.ok) {
        setError(env.error.message);
        // Roll back to the server's last-known truth.
        setAssistantReply(initialAssistantReplyEnabled);
        setForwardToOwner(initialForwardToOwnerEnabled);
        return;
      }
      setAssistantReply(env.data.assistantReplyEnabled);
      setForwardToOwner(env.data.forwardToOwnerEnabled);
      router.refresh();
    } catch {
      setError("Network error");
      setAssistantReply(initialAssistantReplyEnabled);
      setForwardToOwner(initialForwardToOwnerEnabled);
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card>
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-parchment mb-1">
              Staff texting
            </h2>
            <p className="text-xs text-parchment/50 max-w-xl">
              When you or a team member texts your business number, the assistant
              treats you as staff — not a customer — so it never runs the
              lead-intake script. Choose how it should respond.
            </p>
          </div>
          {assistantReply && <Badge variant="pending">Assistant on</Badge>}
        </div>

        {/* Reply as assistant */}
        <div className="border-t border-parchment/10 pt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-parchment">Reply as assistant</p>
            <p className="text-xs text-parchment/50 mt-0.5">
              {assistantReply
                ? "Staff texts get an internal-assistant reply, like the dashboard chat."
                : "Staff texts are not answered by the assistant."}
            </p>
          </div>
          <div className="shrink-0">
            <Button
              type="button"
              size="sm"
              variant={assistantReply ? "primary" : "secondary"}
              loading={saving === "reply"}
              onClick={() => save("reply", { assistantReplyEnabled: !assistantReply })}
            >
              {assistantReply ? "On" : "Off"}
            </Button>
          </div>
        </div>

        {/* Forward to owner */}
        <div className="border-t border-parchment/10 pt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-parchment">Forward to owner's cell</p>
            <p className="text-xs text-parchment/50 mt-0.5">
              {forwardToOwner
                ? "Staff texts are also relayed to your forwarding number."
                : "Staff texts are not relayed."}
            </p>
          </div>
          <div className="shrink-0">
            <Button
              type="button"
              size="sm"
              variant={forwardToOwner ? "primary" : "secondary"}
              loading={saving === "forward"}
              onClick={() => save("forward", { forwardToOwnerEnabled: !forwardToOwner })}
            >
              {forwardToOwner ? "On" : "Off"}
            </Button>
          </div>
        </div>

        {error && <p className="text-xs text-spark-orange">{error}</p>}
      </div>
    </Card>
  );
}
