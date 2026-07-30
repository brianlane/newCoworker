/**
 * Known ?topic= values map to a prefilled form subject so CTAs elsewhere
 * (e.g. the white-glove lead button on /pricing and /dashboard/billing) land
 * as labeled leads. Safe for client components (no server imports).
 */
export const CONTACT_TOPIC_DEFS_BY_PARAM: Record<
  string,
  { subjectKey: string; msgKey: string; msgForKey: string }
> = {
  "white-glove": {
    subjectKey: "subjectWhiteGlove",
    msgKey: "msgWhiteGlove",
    msgForKey: "msgWhiteGloveFor"
  },
  enterprise: {
    subjectKey: "subjectEnterprise",
    msgKey: "msgEnterprise",
    msgForKey: "msgEnterpriseFor"
  },
  support: { subjectKey: "subjectSupport", msgKey: "msgSupport", msgForKey: "msgSupportFor" }
};
