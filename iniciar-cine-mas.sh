#!/bin/sh
# CINE-MÁS para Linux.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Falta Node.js. Instálalo con el gestor de paquetes de tu sistema."
  exit 1
fi
exec node server.js --abrir
