---
name: voice-flows-leave-no-run-rows
description: "voice-triggered AiFlows compile inline in telnyx-voice-inbound and never create ai_flow_runs rows, so zero runs proves nothing"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8f2b787e-f040-4fd9-ab8f-a9377a79fb28
  modified: 2026-08-16T23:17:38.174Z
---

A `channel: "voice"` AiFlow (trigger.fromE164 matching the caller) is compiled
and executed inline inside `supabase/functions/telnyx-voice-inbound/index.ts`
(matchVoiceFlowByCaller then compileVoiceFlow then runHandoffChain). It never
enqueues an `ai_flow_runs` row.

**Why:** I nearly concluded "the HomeLight voice flow did not fire" from
`ai_flow_runs` having zero rows for it, while the call log showed it fired
perfectly (event `voice_ai_first_started` in system_logs, source voice).

**How to apply:** to check whether a voice flow handled a call, read
`system_logs` (source `voice`, events like voice_ai_first_started /
voice_flow_matched telemetry) and `voice_call_transcripts`, never
`ai_flow_runs`. Related: [[homelight-claim-click-silent-noop]].
