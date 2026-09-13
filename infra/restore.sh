#!/usr/bin/env bash
# Phase 12A — restores a backup produced by infra/backup.sh into a NEW,
# clean database, never over the live one. See
# docs/database-backup-recovery.md's "Restore procedure" section for the
# full incident-response steps this script covers only step 4-6 of.
#
# Deliberately restores into a NEW database (default name suffixed
# "_restore_<timestamp>"), never DROPping/overwriting the original — an
# operator decides when/how to cut over, this script never does it
# silently or automatically.
#
# Usage:
#   ./infra/restore.sh path/to/verdictvaut-20260101T000000Z.dump [target_db_name]
set -euo pipefail

DUMP_FILE="${1:?Usage: restore.sh <dump-file> [target_db_name]}"
CONTAINER_NAME="${CONTAINER_NAME:-verdictvaut-postgres}"
POSTGRES_USER="${POSTGRES_USER:-verdictvaut}"
# The name of the LIVE database this container actually serves — the one
# safeguard below explicitly refuses to restore over, regardless of
# whatever target name is passed in. Never assume the caller got this
# right; ask explicitly.
ACTIVE_DB="${POSTGRES_DB:-verdictvaut}"
TARGET_DB="${2:-verdictvaut_restore_$(date -u +%Y%m%dT%H%M%SZ)}"

if [ ! -f "$DUMP_FILE" ]; then
  echo "ERROR: dump file not found: $DUMP_FILE" >&2
  exit 1
fi

# Phase 22 — refuse outright if the target name is (or looks like) the
# live database. createdb below would already fail if TARGET_DB exists,
# but that failure mode is generic and easy to work around by accident
# (e.g. a typo'd target that happens to match). This check exists
# specifically so restoring OVER the active production/staging database
# is never one flag away — an operator must explicitly choose a new,
# disposable name every time.
if [ "$TARGET_DB" = "$ACTIVE_DB" ]; then
  echo "REFUSING: target database name '$TARGET_DB' matches the configured ACTIVE database (POSTGRES_DB=$ACTIVE_DB)." >&2
  echo "This script only ever restores into a NEW, disposable database — pass a different target_db_name." >&2
  exit 1
fi

# Phase 22 — verify the backup's own checksum (written by backup.sh)
# before spending time restoring a possibly-corrupted/truncated dump.
# Missing checksum file is a WARNING, not a hard failure (an operator
# may be restoring an older backup taken before this feature existed, or
# a dump obtained by some other means) — but a checksum that exists and
# does NOT match is always a hard failure; never restore data that
# fails its own integrity check.
checksum_file="${DUMP_FILE}.sha256"
if [ -f "$checksum_file" ]; then
  dump_dir="$(dirname "$DUMP_FILE")"
  if (cd "$dump_dir" && sha256sum -c "$(basename "$checksum_file")") >/dev/null 2>&1; then
    echo "Checksum verified: $DUMP_FILE matches $checksum_file."
  else
    echo "ERROR: checksum verification FAILED for $DUMP_FILE — the file may be corrupted or truncated. Refusing to restore." >&2
    exit 1
  fi
else
  echo "WARNING: no checksum file found at $checksum_file — proceeding without integrity verification (this dump predates the checksum feature, or was obtained by another means)." >&2
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "ERROR: container '$CONTAINER_NAME' is not running." >&2
  exit 1
fi

echo "Creating fresh database '$TARGET_DB'..."
docker exec "$CONTAINER_NAME" createdb -U "$POSTGRES_USER" "$TARGET_DB"

echo "Restoring $DUMP_FILE into '$TARGET_DB'..."
docker exec -i "$CONTAINER_NAME" pg_restore -U "$POSTGRES_USER" -d "$TARGET_DB" --no-owner --no-privileges < "$DUMP_FILE"

echo ""
echo "Restore complete into database '$TARGET_DB'."
echo ""
echo "Next steps (see docs/database-backup-recovery.md, Part 17-19):"
echo "  1. Point a throwaway DATABASE_URL at '$TARGET_DB' and run:"
echo "       npx prisma migrate status   # verify schema/migration state matches expectations"
echo "  2. Run the platform's financial integrity checks against it before trusting the data:"
echo "       npm run backup:drill        # (adapt DATABASE_URL, or write a targeted check script)"
echo "  3. Only after verification passes should this database be promoted to serve real traffic —"
echo "     this script never does that automatically."
