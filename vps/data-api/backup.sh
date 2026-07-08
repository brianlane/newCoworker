#!/usr/bin/env bash
# Residency datastore backup (Phase B4) — runs on the tenant's box via the
# residency-backup systemd timer installed by deploy-client.sh.
#
# pg_dump the box datastore, gzip, AES-256 encrypt LOCALLY (the passphrase
# is escrowed centrally in residency_backup_keys; only ciphertext ever
# leaves the box), upload to Supabase Storage under
# business-backups/residency/<BUSINESS_ID>/ (DATA_BACKUP_BUCKET — keep in
# lockstep with src/lib/db/data-backups.ts), and prune local copies.
#
# Env (from /opt/data-api/backup.env, root-only):
#   BUSINESS_ID                     tenant uuid
#   SUPABASE_URL                    https://<ref>.supabase.co
#   SUPABASE_SERVICE_KEY            upload credential
#   RESIDENCY_BACKUP_PASSPHRASE     AES passphrase (escrowed centrally)
#   RESIDENCY_BACKUP_BUCKET         default "business-backups" (DATA_BACKUP_BUCKET)
#   RESIDENCY_BACKUP_DESTINATION    central (upload ciphertext, default) |
#                                   onbox (dumps stay on the box — in-region
#                                   even for ciphertext; no upload at all)
#   RESIDENCY_BACKUP_KEEP           local copies to keep; default 7
#                                   (central) / 28 (onbox = ~7 days at 6h,
#                                   since local copies ARE the DR there)
set -euo pipefail

: "${BUSINESS_ID:?BUSINESS_ID required}"
: "${SUPABASE_URL:?SUPABASE_URL required}"
: "${SUPABASE_SERVICE_KEY:?SUPABASE_SERVICE_KEY required}"
: "${RESIDENCY_BACKUP_PASSPHRASE:?RESIDENCY_BACKUP_PASSPHRASE required}"
BUCKET="${RESIDENCY_BACKUP_BUCKET:-business-backups}"
DESTINATION="${RESIDENCY_BACKUP_DESTINATION:-central}"
if [[ "${DESTINATION}" == "onbox" ]]; then
  KEEP="${RESIDENCY_BACKUP_KEEP:-28}"
else
  KEEP="${RESIDENCY_BACKUP_KEEP:-7}"
fi

BACKUP_DIR="/opt/data-api/backups"
mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
FILE="residency-${STAMP}.sql.gz.enc"
OUT="${BACKUP_DIR}/${FILE}"

# Dump INSIDE the compose network; plaintext never touches disk — the
# pipeline goes dump → gzip → encrypt in one stream.
docker compose -f /opt/data-api/docker-compose.yml exec -T residency-postgres \
  pg_dump -U dataapi --clean --if-exists residency \
  | gzip \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:RESIDENCY_BACKUP_PASSPHRASE \
  > "${OUT}"
chmod 600 "${OUT}"

SIZE=$(stat -c%s "${OUT}")
if [[ "${SIZE}" -lt 128 ]]; then
  echo "FATAL: backup suspiciously small (${SIZE} bytes) — refusing to upload/prune" >&2
  exit 1
fi

if [[ "${DESTINATION}" == "onbox" ]]; then
  # In-region-only mode: even ciphertext never leaves the box. The rotated
  # local set IS the DR (disclosed per-deal trade — a dead box loses it).
  ls -1t "${BACKUP_DIR}"/residency-*.sql.gz.enc 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f
  echo "residency backup ok: ${FILE} (${SIZE} bytes, kept on-box; destination=onbox, no upload)"
  exit 0
fi

# Upload ciphertext. x-upsert lets a same-second rerun overwrite instead of 409.
HTTP=$(curl -sS -o /tmp/residency-backup-upload.out -w "%{http_code}" -X POST \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Content-Type: application/octet-stream" \
  -H "x-upsert: true" \
  --data-binary "@${OUT}" \
  "${SUPABASE_URL}/storage/v1/object/${BUCKET}/residency/${BUSINESS_ID}/${FILE}")
if [[ "${HTTP}" != "200" ]]; then
  echo "FATAL: ciphertext upload failed (HTTP ${HTTP}): $(cat /tmp/residency-backup-upload.out)" >&2
  # Local copy is kept — the next timer run retries the upload cadence.
  exit 1
fi

# Prune local copies beyond KEEP (newest first survive).
ls -1t "${BACKUP_DIR}"/residency-*.sql.gz.enc 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f

echo "residency backup ok: ${FILE} (${SIZE} bytes, uploaded to ${BUCKET}/residency/${BUSINESS_ID}/)"
