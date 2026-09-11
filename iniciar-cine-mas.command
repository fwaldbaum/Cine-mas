#!/bin/sh
# CINE-MÁS para macOS: doble clic en este archivo.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Falta Node.js. Instálalo desde https://nodejs.org y vuelve a abrir este archivo."
  echo ""
  read -r _ 
  exit 1
fi
exec node server.js --abrir
