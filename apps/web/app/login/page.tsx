"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { TextField } from "../../components/ui/TextField";
import { ApiError } from "../../lib/api-client";
import { useAuth } from "../../lib/auth/auth-context";

export default function LoginPage() {
  const { login, status } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/wallet");
    }
  }, [status, router]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await login(email, password);
      router.replace("/wallet");
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setError("Invalid email or password.");
      } else if (err instanceof ApiError && err.isRateLimited) {
        setError("Too many attempts. Please wait a moment and try again.");
      } else {
        setError("Something went wrong signing you in. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-vault-gold" aria-hidden="true" />
          <span className="font-display text-sm font-semibold uppercase tracking-[0.3em] text-white">VerdictVaut</span>
        </div>

        <div className="rounded-xl border border-vault-border bg-vault-surface p-6">
          <h1 className="font-display text-lg font-semibold text-white">Sign in</h1>
          <p className="mt-1 text-sm text-white/50">Access your wallet and deposit history.</p>

          <form className="mt-6 flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {error && (
              <p role="alert" className="rounded-md border border-vault-down/30 bg-vault-down/5 px-3 py-2 text-sm text-vault-down">
                {error}
              </p>
            )}

            <Button type="submit" isLoading={isSubmitting} className="mt-2 w-full">
              Sign in
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-white/40">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="font-medium text-vault-gold hover:underline">
            Create one
          </Link>
        </p>
      </div>
    </main>
  );
}
