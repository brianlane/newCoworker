/**
 * The tag delta for moving a contact between pipeline stages.
 *
 * The implementation lives in
 * `supabase/functions/_shared/pipelines/stages.ts` so the Deno AiFlow worker
 * can share it (the worker cannot resolve the `@/` alias). This module stays
 * as the app-side import path every caller already uses.
 */

export {
  computeStageMove,
  type StageMoveDelta
} from "../../../supabase/functions/_shared/pipelines/stages";
