#!/bin/sh
# Restauration d'une sauvegarde produite par backup-db.sh.
#   DATABASE_URL=postgres://… ./deploy/scripts/restore-db.sh backups/nuera-dev-20261105T020000Z.dump
# ATTENTION : remplace le contenu de la base cible. Arrêter `web` et `runner` avant de restaurer.
set -eu

: "${DATABASE_URL:?DATABASE_URL requis}"
FILE="${1:?Chemin du fichier .dump requis}"
[ -f "${FILE}" ] || { echo "Fichier introuvable : ${FILE}" >&2; exit 1; }

printf 'Restaurer %s dans la base cible ? Toutes les données actuelles seront remplacées. Tapez RESTAURER : ' "${FILE}"
read -r answer
[ "${answer}" = "RESTAURER" ] || { echo "Annulé."; exit 1; }

pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction --dbname="${DATABASE_URL}" "${FILE}"
echo "Restauration terminée. Relancez les services puis vérifiez /api/health."
