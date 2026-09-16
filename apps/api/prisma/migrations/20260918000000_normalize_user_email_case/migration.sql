-- Phase 30 — RegisterDto/LoginDto now normalize a new user's email to
-- lowercase before it ever reaches the database (see those DTOs' own
-- comments), closing a real gap: without this, "Foo@x.com" and
-- "foo@x.com" were two distinct accounts under the DB's case-sensitive
-- unique constraint, and a user whose login attempt was cased
-- differently from their registration (e.g. a mobile keyboard
-- auto-capitalizing the first letter) got a false "invalid
-- credentials" and was locked out of their own real account.
--
-- This migration normalizes every EXISTING row the same way, so the
-- fix applies uniformly rather than only to accounts created after
-- this deploy. It is intentionally conservative: a row is only
-- lowercased when doing so would not collide with another existing
-- row's lowercased email. If two accounts already differ only by
-- case (e.g. both "Foo@x.com" and "foo@x.com" are already registered
-- — never observed in this repository's own seed/test data, but not
-- assumed impossible for a real deployment), BOTH are left untouched
-- rather than this migration guessing which one to keep, merge, or
-- rename — that is a real account-ownership decision requiring human
-- judgment, not something a migration should decide unilaterally.
UPDATE "users" AS u
SET "email" = LOWER(u."email")
WHERE u."email" <> LOWER(u."email")
  AND NOT EXISTS (
    SELECT 1 FROM "users" AS collision
    WHERE collision."id" <> u."id"
      AND LOWER(collision."email") = LOWER(u."email")
  );
