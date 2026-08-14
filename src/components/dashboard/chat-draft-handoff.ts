"use client";

/**
 * The creation-draft hand-off contract, shared by the /dashboard/chat page
 * and the Ask AI companion panel: stash the draft in sessionStorage under
 * the SAME keys the AiFlows library "Adapt with AI" flow reads, then
 * navigate to the matching editor. Nothing is saved until the owner saves
 * it there. Returns false when the browser blocked session storage so the
 * shell can show its own error copy.
 */

import type { ChatDraft } from "@/components/dashboard/useDashboardChatTransport";

export function stashDraftForEditor(
  draft: ChatDraft,
  navigate: (href: string) => void
): boolean {
  try {
    if (draft.kind === "aiflow") {
      sessionStorage.setItem("aiflow_adapt_draft", JSON.stringify(draft.definition));
      if (draft.warnings.length > 0) {
        sessionStorage.setItem("aiflow_adapt_warnings", JSON.stringify(draft.warnings));
      } else {
        sessionStorage.removeItem("aiflow_adapt_warnings");
      }
      navigate("/dashboard/aiflows?adapt=1");
    } else {
      sessionStorage.setItem(
        "agent_create_draft",
        JSON.stringify({
          name: draft.name,
          instructions: draft.instructions,
          outputFormat: draft.outputFormat
        })
      );
      navigate("/dashboard/agents?draft=1");
    }
    return true;
  } catch {
    return false;
  }
}
