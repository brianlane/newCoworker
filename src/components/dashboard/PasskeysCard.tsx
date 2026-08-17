"use client";

import { useCallback, useEffect, useState } from "react";
import type { VerifyPasskeyRegistrationParams } from "@supabase/supabase-js";
import { KeyRound } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { isPasskeyCeremonyCancellation, passkeyErrorMessage } from "@/lib/auth/passkey-errors";
import {
  applyAuthenticatorPreference,
  supportsWebAuthnJson,
  type PasskeyAuthenticatorPreference
} from "@/lib/auth/passkey-registration";
import { browserSupportsPasskeys, getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { OwnLoginNotice } from "@/components/dashboard/OwnLoginNotice";

type SupabaseAuth = ReturnType<typeof getSupabaseBrowserClient>["auth"];

/**
 * Runs the registration ceremony ourselves so we can tell the browser which
 * kind of authenticator the owner asked for. Supabase's one-shot
 * `registerPasskey()` sends the server's options verbatim, and those state no
 * preference, so Chrome opens a chooser instead of going straight to Touch ID
 * and iCloud Keychain.
 *
 * Only the authenticator preference is restated. Everything the server signs
 * against (challenge, relying party, resident-key requirement) is passed
 * through, and the challenge id goes back untouched for verification.
 */
async function registerWithPreference(
  auth: SupabaseAuth,
  preference: PasskeyAuthenticatorPreference
): Promise<{ error: unknown | null }> {
  // Browsers without the Level 3 JSON helpers cannot round-trip the options,
  // so they get the SDK's own flow and the chooser that comes with it.
  if (!supportsWebAuthnJson()) {
    const { error } = await auth.registerPasskey();
    return { error };
  }

  const { data: challenge, error: startError } = await auth.passkey.startRegistration();
  if (startError || !challenge) {
    return { error: startError ?? new Error("No registration challenge was issued.") };
  }

  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(
    applyAuthenticatorPreference(
      challenge.options as unknown as PublicKeyCredentialCreationOptionsJSON,
      preference
    )
  );

  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!credential) return { error: new Error("No passkey was created.") };

  const { error: verifyError } = await auth.passkey.verifyRegistration({
    challengeId: challenge.challenge_id,
    credential: credential.toJSON() as VerifyPasskeyRegistrationParams["credential"]
  });
  return { error: verifyError };
}

type Passkey = {
  id: string;
  friendly_name?: string;
  created_at: string;
  last_used_at?: string;
};

/**
 * Settings → Account: register and manage passkeys for this account.
 *
 * This card is the only way a passkey ever gets created, so /login's "Sign in
 * with a passkey" button is dead weight without it. Registration runs against
 * the Supabase relying party (`newcoworker.com`), which means it only works on
 * the real domain, never on localhost.
 *
 * SESSION-scoped, so it cannot follow admin view-as: `supabase.auth.passkey.*`
 * enrolls the device holding the caller's session, and there is no API to
 * enroll someone else's. `ownLoginNotice` labels it instead (see
 * OwnLoginNotice), the same treatment the password card gets.
 */
export function PasskeysCard({ ownLoginNotice }: { ownLoginNotice?: string } = {}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [registering, setRegistering] = useState<PasskeyAuthenticatorPreference | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error: listError } = await supabase.auth.passkey.list();
      if (listError) {
        setError(passkeyErrorMessage(listError, "We could not load your passkeys."));
        setPasskeys([]);
        return;
      }
      setPasskeys(data ?? []);
    } catch (err) {
      setError(passkeyErrorMessage(err, "We could not load your passkeys."));
      setPasskeys([]);
    }
  }, []);

  useEffect(() => {
    const available = browserSupportsPasskeys();
    setSupported(available);
    if (available) void load();
  }, [load]);

  async function addPasskey(preference: PasskeyAuthenticatorPreference) {
    setRegistering(preference);
    setError(null);
    setNotice(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: registerError } = await registerWithPreference(supabase.auth, preference);
      if (registerError) {
        if (!isPasskeyCeremonyCancellation(registerError)) {
          setError(passkeyErrorMessage(registerError, "We could not add that passkey."));
        }
        return;
      }
      setNotice("Passkey added. You can use it to sign in from now on.");
      await load();
    } catch (err) {
      if (!isPasskeyCeremonyCancellation(err)) {
        setError(passkeyErrorMessage(err, "We could not add that passkey."));
      }
    } finally {
      setRegistering(null);
    }
  }

  async function saveRename(passkeyId: string) {
    const friendlyName = renameValue.trim();
    if (!friendlyName) return;
    setBusyId(passkeyId);
    setError(null);
    setNotice(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: updateError } = await supabase.auth.passkey.update({
        passkeyId,
        friendlyName
      });
      if (updateError) {
        setError(passkeyErrorMessage(updateError, "We could not rename that passkey."));
        return;
      }
      setRenamingId(null);
      await load();
    } catch (err) {
      setError(passkeyErrorMessage(err, "We could not rename that passkey."));
    } finally {
      setBusyId(null);
    }
  }

  async function removePasskey(passkeyId: string) {
    setBusyId(passkeyId);
    setError(null);
    setNotice(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: deleteError } = await supabase.auth.passkey.delete({ passkeyId });
      if (deleteError) {
        setError(passkeyErrorMessage(deleteError, "We could not remove that passkey."));
        return;
      }
      setConfirmingDeleteId(null);
      setNotice("Passkey removed.");
      await load();
    } catch (err) {
      setError(passkeyErrorMessage(err, "We could not remove that passkey."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-1">Passkeys</h2>
      <OwnLoginNotice show={Boolean(ownLoginNotice)}>{ownLoginNotice ?? ""}</OwnLoginNotice>
      <p className="text-xs text-parchment/40 mb-4">
        Sign in with your fingerprint, face, or device PIN instead of a password. Add one per
        device you use.
      </p>

      {supported === false ? (
        <p className="text-xs text-parchment/50">
          This browser does not support passkeys. Try a current version of Chrome, Safari, or Edge.
        </p>
      ) : (
        <div className="space-y-3">
          {passkeys === null ? (
            <p className="text-xs text-parchment/40">Loading your passkeys…</p>
          ) : passkeys.length === 0 ? (
            <p className="text-xs text-parchment/50">
              No passkeys yet. Add one and you can skip your password next time.
            </p>
          ) : (
            <ul className="space-y-2">
              {passkeys.map((passkey) => (
                <li
                  key={passkey.id}
                  className="rounded-lg border border-parchment/10 bg-parchment/5 px-3 py-2"
                >
                  {renamingId === passkey.id ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <Input
                        label="Passkey name"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        maxLength={120}
                        className="flex-1 min-w-[12rem]"
                      />
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          loading={busyId === passkey.id}
                          disabled={!renameValue.trim()}
                          onClick={() => void saveRename(passkey.id)}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setRenamingId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <KeyRound className="h-4 w-4 shrink-0 text-parchment/40" aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="truncate text-sm text-parchment">
                            {passkey.friendly_name || "Unnamed passkey"}
                          </p>
                          <p className="text-[11px] text-parchment/40">
                            Added <LocalDateTime iso={passkey.created_at} style="date" />
                            {passkey.last_used_at ? (
                              <>
                                {" · Last used "}
                                <LocalDateTime iso={passkey.last_used_at} style="date" />
                              </>
                            ) : (
                              " · Never used"
                            )}
                          </p>
                        </div>
                      </div>
                      {confirmingDeleteId === passkey.id ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-parchment/60">Remove it?</span>
                          <Button
                            type="button"
                            size="sm"
                            variant="danger"
                            loading={busyId === passkey.id}
                            onClick={() => void removePasskey(passkey.id)}
                          >
                            Remove
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmingDeleteId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3 text-xs">
                          <button
                            type="button"
                            className="text-parchment/50 hover:text-signal-teal"
                            onClick={() => {
                              setConfirmingDeleteId(null);
                              setRenamingId(passkey.id);
                              setRenameValue(passkey.friendly_name ?? "");
                            }}
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            className="text-parchment/50 hover:text-spark-orange"
                            onClick={() => {
                              setRenamingId(null);
                              setConfirmingDeleteId(passkey.id);
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              loading={registering === "this-device"}
              disabled={supported === null || registering !== null}
              onClick={() => void addPasskey("this-device")}
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              Add a passkey on this device
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              loading={registering === "any"}
              disabled={supported === null || registering !== null}
              onClick={() => void addPasskey("any")}
            >
              Use a phone or security key
            </Button>
          </div>
          <div className="space-y-1">
            <p className="text-[11px] text-parchment/40">
              On a Mac, adding a passkey on this device saves it to iCloud Keychain with Touch ID,
              so it works on your iPhone and iPad too.
            </p>
            {notice && <p className="text-xs text-claw-green">{notice}</p>}
            {error && <p className="text-xs text-spark-orange">{error}</p>}
          </div>
        </div>
      )}
    </Card>
  );
}
