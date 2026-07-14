/**
 * Pipeline board types + caps (GoHighLevel-style lead pipelines).
 *
 * A pipeline is an ordered list of STAGES, and each stage is BACKED BY A
 * CONTACT TAG: a contact "is in" a stage when its `contacts.tags` carries
 * the stage's name (case-insensitive, like every other tag comparison in
 * the platform). Storage-wise the board is a pure VIEW over tags — there is
 * no opportunities table — which keeps AiFlow `update_contact` steps and
 * `tag_changed` triggers moving leads across the board with zero new
 * automation surface.
 *
 * Types-only module (no Supabase import) so client components can import
 * the shapes without pulling server-only code.
 */

/** Caps enforced by the API (mirrored loosely by DB check constraints). */
export const MAX_PIPELINES_PER_BUSINESS = 10;
export const MAX_STAGES_PER_PIPELINE = 15;
export const MAX_PIPELINE_NAME_LENGTH = 80;
/** Stage names are contact tags, so they share the 40-char tag cap. */
export const MAX_STAGE_NAME_LENGTH = 40;

/** Small named palette for column accents; validated on every write. */
export const STAGE_COLORS = [
  "teal",
  "green",
  "orange",
  "rose",
  "violet",
  "sky",
  "amber",
  "slate"
] as const;
export type StageColor = (typeof STAGE_COLORS)[number];

/** Clamp any stored/user value onto the palette (default accent otherwise). */
export function normalizeStageColor(raw: string | null | undefined): StageColor {
  return (STAGE_COLORS as readonly string[]).includes(raw ?? "")
    ? (raw as StageColor)
    : "teal";
}

export type PipelineStage = {
  id: string;
  pipelineId: string;
  /** The stage IS this contact tag (case-insensitive match). */
  name: string;
  color: StageColor;
  /** 0-based board order, left to right. */
  position: number;
};

export type Pipeline = {
  id: string;
  businessId: string;
  name: string;
  position: number;
  /** Ordered by position ascending. */
  stages: PipelineStage[];
};

/**
 * The one-click starter board. Stage names deliberately match the
 * lead-state tags the AiFlow builder's update_contact preset already writes
 * ("New Lead" → "Contacted"), so existing automations light the board up
 * the moment it's created.
 */
export const DEFAULT_PIPELINE: { name: string; stages: Array<{ name: string; color: StageColor }> } = {
  name: "Leads",
  stages: [
    { name: "New Lead", color: "sky" },
    { name: "Contacted", color: "teal" },
    { name: "Engaged", color: "violet" },
    { name: "Booked", color: "amber" },
    { name: "Won", color: "green" }
  ]
};
