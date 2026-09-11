@echo off
title CINE-MAS
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Falta Node.js. Instalalo desde https://nodejs.org y vuelve a abrir este archivo.
  echo.
  pause
  exit /b 1
)
node server.js --abrir
echo.
echo   CINE-MAS se ha detenido.
pause
