/**
 * Which Google surface a tenant's model calls go to.
 *
 * Every Gemini call in this repo currently targets
 * `generativelanguage.googleapis.com` with an API key. That is the Google AI
 * Studio API, and **Google will not cover it under a BAA**. Only the Google
 * Cloud surface is on the HIPAA covered-products list (published as
 * "Generative AI on Gemini Enterprise Agent Platform" since the April 2026
 * rebrand of Vertex AI Agent Builder), and it is reached on a different host,
 * a different path, and with an OAuth bearer token rather than a key.
 *
 * So "make us HIPAA compliant" is not a prompt change: PHI cannot legally
 * traverse the endpoint we call today, whatever the model says.
 *
 * THE PROPERTY THAT MATTERS HERE IS FAIL-CLOSED. If a tenant is in HIPAA mode
 * and the Google Cloud surface is not configured, this THROWS rather than
 * quietly using the API key. A silent fallback would be the worst possible
 * outcome: the tenant believes they are covered, the deploy looks healthy, and
 * PHI flows through an endpoint no agreement covers. A loud failure is a
 * broken feature; a silent fallback is an undisclosed breach.
 *
 * Lives in _shared because the model callers span three runtimes (the Node
 * app, the Deno ai-flow-worker, and the voice bridge on the tenant box). A
 * lockstep copy of this rule is a leak waiting for the day someone edits one
 * of them.
 */

/** Google AI Studio: an API key, and no BAA is available for it. */
export type AiStudioSurface = { kind: "ai_studio"; apiKey: string };

/** Google Cloud: BAA-eligible, OAuth bearer, project and region scoped. */
export type GoogleCloudSurface = {
  kind: "google_cloud";
  projectId: string;
  location: string;
  accessToken: string;
};

export type ModelSurface = AiStudioSurface | GoogleCloudSurface;

export class ModelSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSurfaceError";
  }
}

/** Config for the covered surface, normally read from the environment. */
export type GoogleCloudConfig = {
  projectId?: string | null;
  location?: string | null;
  accessToken?: string | null;
};

/**
 * Pick the surface for one call.
 *
 * A non-HIPAA tenant keeps AI Studio, which is every tenant today, so this is
 * a no-op for the current fleet. A HIPAA tenant gets the covered surface or an
 * error, never a downgrade.
 */
export function resolveModelSurface(
  hipaaMode: boolean | null | undefined,
  apiKey: string,
  cloud: GoogleCloudConfig = {}
): ModelSurface {
  if (hipaaMode !== true) {
    if (!apiKey.trim()) {
      throw new ModelSurfaceError("resolveModelSurface: no Gemini API key configured");
    }
    return { kind: "ai_studio", apiKey };
  }

  const projectId = (cloud.projectId ?? "").trim();
  const location = (cloud.location ?? "").trim();
  const accessToken = (cloud.accessToken ?? "").trim();
  if (!projectId || !location || !accessToken) {
    const missing = [
      projectId ? null : "projectId",
      location ? null : "location",
      accessToken ? null : "accessToken"
    ]
      .filter(Boolean)
      .join(", ");
    throw new ModelSurfaceError(
      `resolveModelSurface: this tenant is in HIPAA mode but the BAA-covered Google Cloud surface is not configured (missing: ${missing}). ` +
        "Refusing to fall back to the AI Studio endpoint, which no Business Associate Agreement covers."
    );
  }
  return { kind: "google_cloud", projectId, location, accessToken };
}

/** The generateContent endpoint for a surface and model id. */
export function geminiEndpoint(surface: ModelSurface, model: string): string {
  const id = encodeURIComponent(model.trim());
  if (surface.kind === "ai_studio") {
    return `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`;
  }
  const location = encodeURIComponent(surface.location);
  const project = encodeURIComponent(surface.projectId);
  return (
    `https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${id}:generateContent`
  );
}

/** Auth headers for a surface. Key header vs OAuth bearer. */
export function geminiAuthHeaders(surface: ModelSurface): Record<string, string> {
  return surface.kind === "ai_studio"
    ? { "x-goog-api-key": surface.apiKey }
    : { authorization: `Bearer ${surface.accessToken}` };
}

/** True when this surface can legally carry PHI. */
export function surfaceIsBaaCovered(surface: ModelSurface): boolean {
  return surface.kind === "google_cloud";
}
