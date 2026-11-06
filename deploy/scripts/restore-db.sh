#!/bin/sh
# Restauration d'une sauvegarde produite par backup-db.sh.
#   DATABASE_URL=postgres://… ./deploy/scripts/restore-db.sh backups/nuera-dev-20261105T020000Z.dump
#   (pg_restore ≥ 17, celui de l'image postgres:17-bookworm par exemple)
# ATTENTION : remplace le contenu de la base cible. Arrêter `web`, `runner` et chaque serveur supplémentaire
# (`environment-runner`) avant de restaurer. Une sauvegarde antérieure au schéma actuel se restaure dans une base
# recréée vide (docs/DEPLOY.md §12.4). Les droits (GRANT) ne sont pas restaurés, et une sauvegarde de la version
# multi-comptes exige que le rôle `nuera_runner` existe déjà sur le serveur PostgreSQL : voir docs/DEPLOY.md §9.
set -eu

: "${DATABASE_URL:?DATABASE_URL requis}"
FILE="${1:?Chemin du fichier .dump requis}"
[ -f "${FILE}" ] || { echo "Fichier introuvable : ${FILE}" >&2; exit 1; }

# Non interactif (script, cron de test) : RESTORE_CONFIRM=RESTAURER.
answer="${RESTORE_CONFIRM:-}"
if [ -z "${answer}" ]; then
  printf 'Restaurer %s dans la base cible ? Toutes les données actuelles seront remplacées. Tapez RESTAURER : ' "${FILE}"
  read -r answer
fi
[ "${answer}" = "RESTAURER" ] || { echo "Annulé."; exit 1; }

pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --dbname="${DATABASE_URL}" "${FILE}"
echo "Restauration terminée. Relancez les services puis vérifiez /api/health."
