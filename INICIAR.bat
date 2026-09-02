@echo off
setlocal
cd /d "%~dp0"
title Linozera Transmissao V5 Pro
where node >nul 2>nul || (
  echo Node.js nao foi encontrado. Instale Node.js 18 ou superior.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias...
  call npm install || goto :erro
)
echo.
echo Iniciando Linozera Transmissao V5 Pro...
start "" http://localhost:3000
call npm start
exit /b
:erro
echo.
echo Nao foi possivel instalar as dependencias.
pause
exit /b 1
