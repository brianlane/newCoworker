/**
 * CASA 2.2.2: after a password change/reset, terminate other active sessions
 * while keeping the current browser signed in.
 */

type SignOutClient = {
  auth: {
    signOut: (options?: { scope?: "global" | "local" | "others" }) => Promise<{
      error: { message?: string } | null;
    }>;
  };
};

export async function terminateOtherSessions(supabase: SignOutClient): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope: "others" });
  if (error) {
    throw new Error(error.message ?? "Failed to terminate other sessions");
  }
}
