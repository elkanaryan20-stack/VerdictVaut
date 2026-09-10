-- Phase 13 remediation — bounded, auto-expiring per-account login
-- throttle (see src/auth/login-throttle.util.ts). Never a permanent
-- lockout: lockedUntil always expires on its own and a successful login
-- clears both columns immediately.

ALTER TABLE "users" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "lockedUntil" TIMESTAMP(3);

ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_attempts_non_negative_check" CHECK ("failedLoginAttempts" >= 0);
