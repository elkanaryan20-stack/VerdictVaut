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
TARGET_DB="${2:-verdictvaut_restore_$(date -u +%Y%m%dT%H%M%SZ)}"

if [ ! -f "$DUMP_FILE" ]; then
  echo "ERROR: dump file not found: $DUMP_FILE" >&2
  exit 1
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
