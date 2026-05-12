export type BusinessConfigSaveResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

type ConfigPayload = { ok?: boolean; error?: { message?: string } } | null;

/**
 * POST `/api/business/config` from the browser; normalizes JSON errors and network failures.
 *
 * Success is **only** `{ ok: true }` when the response is HTTP OK **and** the body matches
 * **`{ ok: true, data }`** from `successResponse` in `@/lib/api-response`. A bare 200 with HTML, empty body, or `{}`
 * is treated as failure so callers never show “saved” on junk responses.
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
    const payload = (await res.json().catch(() => null)) as ConfigPayload;

    if (!res.ok) {
      const msg =
        payload?.ok === false && typeof payload.error?.message === "string"
          ? payload.error.message
          : "Save failed";
      return { ok: false, errorMessage: msg };
    }

    if (payload?.ok !== true) {
      return { ok: false, errorMessage: "Unexpected response from server" };
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
