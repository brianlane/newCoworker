"use client";

import type { ReactNode } from "react";
import { clearConfidentialBrowserStorage } from "@/lib/auth/clear-confidential-storage";

type SignOutButtonProps = {
  className?: string;
  children: ReactNode;
};

/**
 * Clears confidential browser storage, then submits the server sign-out
 * form so Supabase cookies are revoked and the browser is redirected.
 */
export function SignOutButton({ className, children }: SignOutButtonProps) {
  return (
    <form
      action="/api/auth/signout"
      method="POST"
      onSubmit={() => {
        clearConfidentialBrowserStorage();
      }}
    >
      <button type="submit" className={className}>
        {children}
      </button>
    </form>
  );
}
