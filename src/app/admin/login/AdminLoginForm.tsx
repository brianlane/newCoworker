"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

type AdminLoginFormProps = {
  forceSignOut: boolean;
  adminEmailMissing: boolean;
};

export default function AdminLoginForm({
  forceSignOut,
  adminEmailMissing
}: AdminLoginFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!forceSignOut) return;

    const signOut = async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        await supabase.auth.signOut();
      } catch {
        // ignore — may fail if no session exists
      }
      setError("This account is not authorized for admin access.");
    };

    signOut();
  }, [forceSignOut]);

  function getSafeNext(): string {
    const next = searchParams.get("next") ?? "/admin";
    if (!next.startsWith("/") || next.startsWith("//")) {
      return "/admin";
    }
    return next;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError("");

    const normalizedEmail = email.trim().toLowerCase();

    try {
      const supabase = getSupabaseBrowserClient();
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password
      });

      if (authError) {
        setError(authError.message);
        setIsSubmitting(false);
        return;
      }

      router.replace(getSafeNext());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
      setIsSubmitting(false);
    }
  }

  return (
    <Card>
      {adminEmailMissing && (
        <div className="mb-4 rounded-lg bg-spark-orange/10 border border-spark-orange/30 px-3 py-2">
          <p className="text-sm text-spark-orange">
            ADMIN_EMAIL is not configured. Admin access is disabled.
          </p>
        </div>
      )}

      <form className="space-y-4" onSubmit={handleSubmit}>
        <Input
          label="Email"
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@example.com"
        />

        <Input
          label="Password"
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />

        {error && (
          <div className="rounded-lg bg-spark-orange/10 border border-spark-orange/30 px-3 py-2">
            <p className="text-sm text-spark-orange">{error}</p>
          </div>
        )}

        <Button
          className="w-full"
          type="submit"
          disabled={isSubmitting || adminEmailMissing}
          loading={isSubmitting}
        >
          {isSubmitting ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </Card>
  );
}
