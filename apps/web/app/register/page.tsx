"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { TextField } from "../../components/ui/TextField";
import { ApiError } from "../../lib/api-client";
import { useAuth } from "../../lib/auth/auth-context";

const MIN_PASSWORD_LENGTH = 12;

export default function RegisterPage() {
  const { register, status } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
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

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setIsSubmitting(true);
    try {
      await register(email, password);
      router.replace("/wallet");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("An account with this email already exists.");
      } else if (err instanceof ApiError && err.status === 400) {
        setError(err.message);
      } else if (err instanceof ApiError && err.isRateLimited) {
        setError("Too many attempts. Please wait a moment and try again.");
      } else {
        setError("Something went wrong creating your account. Please try again.");
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
          <h1 className="font-display text-lg font-semibold text-white">Create your account</h1>
          <p className="mt-1 text-sm text-white/50">Sandbox environment — real ledger, testnet blockchain activity only.</p>

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
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <TextField
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />

            {error && (
              <p role="alert" className="rounded-md border border-vault-down/30 bg-vault-down/5 px-3 py-2 text-sm text-vault-down">
                {error}
              </p>
            )}

            <Button type="submit" isLoading={isSubmitting} className="mt-2 w-full">
              Create account
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center text-sm text-white/40">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-vault-gold hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
