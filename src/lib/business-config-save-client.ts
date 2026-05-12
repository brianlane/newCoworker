export type BusinessConfigSaveResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

type ConfigErrorPayload = { ok?: boolean; error?: { message?: string } } | null;

/**
 * POST `/api/business/config` from the browser; normalizes JSON errors and network failures.
 */
export async function postBusinessConfigSave(
  body: Record<string, unknown>
): Promise<BusinessConfigSaveResult> {
  try {
    const res = await fetch("/api/business/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = (await res.json().catch(() => null)) as ConfigErrorPayload;
    if (!res.ok) {
      const msg =
        payload?.ok === false && typeof payload.error?.message === "string"
          ? payload.error.message
          : "Save failed";
      return { ok: false, errorMessage: msg };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      errorMessage:
        err instanceof Error
          ? err.message
          : "Could not save. Check your connection and try again."
    };
  }
}
