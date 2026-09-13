#!/usr/bin/env bash
# Phase 12A — real, runnable backup for the docker-compose Postgres
# instance this repo actually ships (infra/docker-compose.yml). See
# docs/database-backup-recovery.md for the full backup/recovery
# architecture, RPO/RTO status, and what this script does and does not
# cover (it is a viable self-hosted/single-VM backup path — it is
# explicitly NOT a substitute for managed-provider automated backups
# and PITR in a real multi-instance production deployment).
#
# Usage:
#   POSTGRES_USER=... POSTGRES_DB=... BACKUP_DIR=./backups RETENTION_DAYS=30 \
#     ./infra/backup.sh
#
# Requires: the postgres container from infra/docker-compose.yml running
# (docker compose up -d postgres), and Docker CLI on PATH. Does not
# require psql/pg_dump installed on the host — it runs pg_dump INSIDE
# the container, where it's guaranteed to match the server version.
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-verdictvaut-postgres}"
POSTGRES_USER="${POSTGRES_USER:-verdictvaut}"
POSTGRES_DB="${POSTGRES_DB:-verdictvaut}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$0")/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "ERROR: container '$CONTAINER_NAME' is not running. Start it with:" >&2
  echo "  docker compose -f infra/docker-compose.yml up -d postgres" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
# -Fc = pg_dump's custom format: compressed, and the ONLY format
# pg_restore can selectively restore from (schema-only, data-only, or
# specific tables) — plain SQL dumps can't do that.
dest="$BACKUP_DIR/verdictvaut-${timestamp}.dump"

echo "Backing up '$POSTGRES_DB' from container '$CONTAINER_NAME' to $dest ..."
docker exec "$CONTAINER_NAME" pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$dest"

# Fail loudly on a truncated/empty dump rather than silently "succeeding"
# with a useless backup file.
size=$(stat -c%s "$dest" 2>/dev/null || stat -f%z "$dest" 2>/dev/null || echo 0)
if [ "$size" -lt 1024 ]; then
  echo "ERROR: backup file is suspiciously small ($size bytes) — treating as a failed backup." >&2
  printf '{"timestamp":"%s","file":"%s","sizeBytes":%s,"database":"%s","status":"failed","reason":"suspiciously small dump"}\n' \
    "$timestamp" "$(basename "$dest")" "$size" "$POSTGRES_DB" >> "$BACKUP_DIR/backup-metadata.jsonl"
  rm -f "$dest"
  exit 1
fi
echo "Backup complete: $dest ($size bytes)"

# Phase 22 — a sha256 checksum, written alongside the dump, is the
# integrity-verification artifact restore.sh checks BEFORE attempting a
# restore (see that script) — catches silent corruption/truncation from
# disk/network transfer/off-site-copy handling that a size check alone
# would miss. Written with the bare filename only (not the full path) so
# `sha256sum -c` remains portable if the file is later moved.
checksum_file="${dest}.sha256"
(cd "$BACKUP_DIR" && sha256sum "$(basename "$dest")" > "$(basename "$checksum_file")")
echo "Checksum written: $checksum_file"

# Phase 22 — a minimal backup-metadata record (timestamp, size, database
# name — never credentials) so "when did the last backup actually run,
# and did it succeed" is answerable from a file, not tribal knowledge.
# Appended, one JSON line per backup, to a log a monitoring job can tail
# — see docs/production-database-readiness.md's "routine backup
# monitoring" runbook for how this is intended to be consumed.
metadata_log="$BACKUP_DIR/backup-metadata.jsonl"
printf '{"timestamp":"%s","file":"%s","sizeBytes":%s,"database":"%s","status":"success"}\n' \
  "$timestamp" "$(basename "$dest")" "$size" "$POSTGRES_DB" >> "$metadata_log"

# Retention: delete local backups older than RETENTION_DAYS. This prunes
# the LOCAL copy only — see docs/database-backup-recovery.md's "off-site
# storage" section for why a local-disk-only backup is not sufficient on
# its own (the same disk failure/host loss that destroys the database
# destroys its backups too).
find "$BACKUP_DIR" -name 'verdictvaut-*.dump' -mtime +"$RETENTION_DAYS" -print -delete
