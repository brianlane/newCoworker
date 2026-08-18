/**
 * Business knowledge tools: read and section-splice the coworker's
 * identity document (`business_configs.identity_md`), services, pricing,
 * greetings, policies. The one-shot class this makes self-serve is the
 * Scar Fairy repair: a broken greeting or a missing price fixed by editing
 * ONE section, never by rewriting the document.
 *
 * OWNER-ONLY, twice over: the handler requires the caller's role to be
 * literally `owner` (manage_settings is not enough, this document IS the
 * coworker's voice), and the splice core refuses whole-document rewrites
 * structurally. Writes ride the identity editor's exact pipeline
 * (patchBusinessConfig + KG extract + vault sync), so chat edits and
 * dashboard edits can never diverge.
 */

import { z } from "zod";
import { McpToolError, requireMcpBusinessRole, resolveMcpBusinessId } from "@/lib/mcp/auth";
import { defineMcpTool, TOOL_BEHAVIOR } from "@/lib/mcp/tooling";
import {
  KNOWLEDGE_SPLICE_MAX_CHARS,
  readBusinessKnowledge,
  updateBusinessKnowledgeCore
} from "@/lib/knowledge-tools/identity-sections";

const SECTION_SHAPE = z.object({
  index: z.number(),
  heading: z.string().nullable(),
  content: z.string()
});

async function requireOwner(
  auth: Parameters<typeof requireMcpBusinessRole>[0],
  businessId: string
): Promise<void> {
  const role = await requireMcpBusinessRole(auth, businessId, "manage_settings");
  if (role !== "owner") {
    throw new McpToolError("Only the business owner can work with the coworker's knowledge.");
  }
}

export const getBusinessKnowledgeTool = defineMcpTool({
  name: "get_business_knowledge",
  title: "Read the coworker's knowledge",
  annotations: TOOL_BEHAVIOR.readLocal,
  outputSchema: z.object({
    sections: z.array(SECTION_SHAPE),
    total_chars: z.number()
  }),
  description:
    "Read the coworker's identity document (services, pricing, greetings, policies) split into its markdown sections, each with a stable index. Call this BEFORE update_business_knowledge so you edit the right section with its real current text. Owner only.",
  schema: {
    business_id: z
      .string()
      .uuid()
      .optional()
      .describe("Business to read. Optional when the account has exactly one business.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireOwner(auth, businessId);
    return await readBusinessKnowledge(businessId);
  }
});

export const updateBusinessKnowledgeTool = defineMcpTool({
  name: "update_business_knowledge",
  title: "Edit one knowledge section",
  annotations: TOOL_BEHAVIOR.mutateLocal,
  outputSchema: z.object({
    updated: z.boolean(),
    sections: z.array(SECTION_SHAPE),
    total_chars: z.number()
  }),
  description:
    `Replace ONE section of the coworker's identity document, or append one new heading-led section. Whole-document rewrites are refused by design: call get_business_knowledge first, then target the section by heading or index. mode "replace" keeps the section's heading line and swaps its body; mode "append_section" adds new content that must start with its own markdown heading. Content is capped at ${KNOWLEDGE_SPLICE_MAX_CHARS} characters per edit. The live coworker picks the change up right away. Owner only.`,
  schema: {
    business_id: z
      .string()
      .uuid()
      .optional()
      .describe("Business to update. Optional when the account has exactly one business."),
    mode: z
      .enum(["replace", "append_section"])
      .describe('"replace" swaps one section\'s body; "append_section" adds a new section at the end.'),
    section_heading: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe('For replace: the section\'s heading text, e.g. "Pricing".'),
    section_index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("For replace: the section's index from get_business_knowledge (wins over heading)."),
    content: z
      .string()
      .min(1)
      .max(KNOWLEDGE_SPLICE_MAX_CHARS)
      .describe("The new section text (for append_section, start with a markdown heading line).")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireOwner(auth, businessId);
    const result = await updateBusinessKnowledgeCore(businessId, {
      mode: args.mode,
      ...(args.section_index !== undefined ? { sectionIndex: args.section_index } : {}),
      ...(args.section_heading !== undefined ? { sectionHeading: args.section_heading } : {}),
      content: args.content
    });
    if (!result.ok) throw new McpToolError(result.message);
    return { updated: true, sections: result.sections, total_chars: result.total_chars };
  }
});

export const businessKnowledgeTools = [getBusinessKnowledgeTool, updateBusinessKnowledgeTool];
