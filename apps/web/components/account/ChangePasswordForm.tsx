"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { useChangePassword } from "../../lib/account/hooks";
import { ApiError } from "../../lib/api-client";
import { useAuth } from "../../lib/auth/auth-context";
import { Button } from "../ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { TextField } from "../ui/TextField";

/**
 * A successful change revokes every one of the user's sessions
 * server-side (see AuthService.changePassword) — this one's tokens
 * included, since nothing ties an access token back to a specific
 * refresh-token row. So success here always ends in a real sign-out,
 * never a silent "your password changed but you're still logged in" —
 * that would be showing a state the backend no longer agrees with.
 */
export function ChangePasswordForm() {
  const { logout } = useAuth();
  const router = useRouter();
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);

    if (newPassword.length < 12) {
      setFormError("New password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setFormError("New password and confirmation don't match.");
      return;
    }

    try {
      await changePassword.mutateAsync({ currentPassword, newPassword });
      setSucceeded(true);
    } catch (err) {
      // 403, not 401 — a wrong current password is a business-logic
      // rejection on an already-authenticated request, never treated as
      // an expired access token (see AuthService.changePassword's
      // docblock for why that distinction matters to apiFetch).
      if (err instanceof ApiError && err.status === 403) {
        setFormError("Current password is incorrect.");
      } else if (err instanceof ApiError && err.isRateLimited) {
        setFormError("Too many attempts. Please wait a moment and try again.");
      } else {
        setFormError("Something went wrong changing your password. Please try again.");
      }
    }
  }

  async function handleContinueToSignIn() {
    await logout();
    router.replace("/login");
  }

  if (succeeded) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <p role="status" className="rounded-md border border-vault-up/30 bg-vault-up/5 px-3 py-2 text-sm text-vault-up">
            Your password has been changed. For your security, you&apos;ve been signed out everywhere — please sign in again.
          </p>
          <Button type="button" onClick={handleContinueToSignIn}>
            Continue to sign in
          </Button>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardBody>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <TextField
            label="Current password"
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            hint="At least 12 characters."
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <TextField
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />

          {formError && (
            <p role="alert" className="rounded-md border border-vault-down/30 bg-vault-down/5 px-3 py-2 text-sm text-vault-down">
              {formError}
            </p>
          )}

          <Button type="submit" isLoading={changePassword.isPending} className="self-start">
            Change password
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
