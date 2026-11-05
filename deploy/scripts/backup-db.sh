#!/bin/sh
# Sauvegarde logique de la base Nuera Dev (format custom pg_dump, compressé).
#   DATABASE_URL=postgres://… ./deploy/scripts/backup-db.sh [dossier_cible]
# Conserve les 14 dernières sauvegardes. À planifier (cron Coolify / systemd timer) une fois par jour.
set -eu

: "${DATABASE_URL:?DATABASE_URL requis}"
TARGET_DIR="${1:-${BACKUP_DIR:-./backups}}"
KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${TARGET_DIR}/nuera-dev-${STAMP}.dump"

mkdir -p "${TARGET_DIR}"
umask 077
pg_dump --format=custom --no-owner --no-privileges --compress=9 --file="${FILE}" "${DATABASE_URL}"
echo "Sauvegarde écrite : ${FILE} ($(du -h "${FILE}" | cut -f1))"

# Rotation
ls -1t "${TARGET_DIR}"/nuera-dev-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f -- "${old}" && echo "Supprimée (rotation) : ${old}"
done
