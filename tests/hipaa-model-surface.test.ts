import { describe, expect, it } from "vitest";
import {
  ModelSurfaceError,
  geminiAuthHeaders,
  geminiEndpoint,
  resolveModelSurface,
  surfaceIsBaaCovered
} from "../supabase/functions/_shared/hipaa_model_surface";

const CLOUD = { projectId: "nc-health", location: "us-central1", accessToken: "ya29.token" };

describe("hipaa/model-surface", () => {
  describe("resolveModelSurface", () => {
    it("keeps every non-HIPAA tenant on AI Studio, unchanged", () => {
      for (const mode of [false, null, undefined]) {
        expect(resolveModelSurface(mode, "AIza-key")).toEqual({
          kind: "ai_studio",
          apiKey: "AIza-key"
        });
      }
    });

    it("uses the covered Google Cloud surface for a HIPAA tenant", () => {
      expect(resolveModelSurface(true, "AIza-key", CLOUD)).toEqual({
        kind: "google_cloud",
        projectId: "nc-health",
        location: "us-central1",
        accessToken: "ya29.token"
      });
    });

    it("REFUSES to fall back to AI Studio when the covered surface is unconfigured", () => {
      // The single most important behavior in this module. A silent fallback
      // would mean the tenant believes they are covered while PHI flows
      // through an endpoint no agreement covers.
      expect(() => resolveModelSurface(true, "AIza-key")).toThrow(ModelSurfaceError);
      expect(() => resolveModelSurface(true, "AIza-key")).toThrow(/Refusing to fall back/);
    });

    it("names exactly which pieces are missing", () => {
      expect(() => resolveModelSurface(true, "k", { location: "us-central1", accessToken: "t" })).toThrow(
        /missing: projectId/
      );
      expect(() => resolveModelSurface(true, "k", { projectId: "p", accessToken: "t" })).toThrow(
        /missing: location/
      );
      expect(() => resolveModelSurface(true, "k", { projectId: "p", location: "l" })).toThrow(
        /missing: accessToken/
      );
      expect(() => resolveModelSurface(true, "k", {})).toThrow(
        /missing: projectId, location, accessToken/
      );
    });

    it("treats whitespace-only cloud config as missing, not present", () => {
      expect(() =>
        resolveModelSurface(true, "k", { projectId: "  ", location: " ", accessToken: "\t" })
      ).toThrow(ModelSurfaceError);
    });

    it("still requires an API key on the non-HIPAA path", () => {
      expect(() => resolveModelSurface(false, "   ")).toThrow(/no Gemini API key/);
    });
  });

  describe("geminiEndpoint", () => {
    it("builds the AI Studio URL byte-identically to the previous hardcoded one", () => {
      // Pins the no-change guarantee for the current fleet.
      expect(geminiEndpoint({ kind: "ai_studio", apiKey: "k" }, "gemini-3-flash-preview")).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent"
      );
    });

    it("builds a regional Google Cloud URL", () => {
      expect(geminiEndpoint(resolveModelSurface(true, "k", CLOUD), "gemini-3-flash-preview")).toBe(
        "https://us-central1-aiplatform.googleapis.com/v1/projects/nc-health" +
          "/locations/us-central1/publishers/google/models/gemini-3-flash-preview:generateContent"
      );
    });

    it("trims and URL-encodes the model id on both surfaces", () => {
      expect(geminiEndpoint({ kind: "ai_studio", apiKey: "k" }, "  weird/model  ")).toContain(
        "models/weird%2Fmodel:generateContent"
      );
      expect(geminiEndpoint(resolveModelSurface(true, "k", CLOUD), " a b ")).toContain(
        "models/a%20b:generateContent"
      );
    });
  });

  describe("geminiAuthHeaders", () => {
    it("sends the key header on AI Studio and a bearer on Google Cloud", () => {
      expect(geminiAuthHeaders({ kind: "ai_studio", apiKey: "AIza-key" })).toEqual({
        "x-goog-api-key": "AIza-key"
      });
      expect(geminiAuthHeaders(resolveModelSurface(true, "k", CLOUD))).toEqual({
        authorization: "Bearer ya29.token"
      });
    });

    it("never leaks the API key onto the covered surface", () => {
      const headers = geminiAuthHeaders(resolveModelSurface(true, "AIza-key", CLOUD));
      expect(JSON.stringify(headers)).not.toContain("AIza-key");
    });
  });

  describe("surfaceIsBaaCovered", () => {
    it("is true only for Google Cloud", () => {
      expect(surfaceIsBaaCovered({ kind: "ai_studio", apiKey: "k" })).toBe(false);
      expect(surfaceIsBaaCovered(resolveModelSurface(true, "k", CLOUD))).toBe(true);
    });
  });
});
