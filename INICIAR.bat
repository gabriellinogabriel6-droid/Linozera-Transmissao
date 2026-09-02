@echo off
chcp 65001 >nul
cd /d "%~dp0"
title LNZ Transmissao

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERRO] Node.js nao foi encontrado.
  echo Instale Node.js 18 ou superior e tente novamente.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERRO] Nao foi possivel instalar as dependencias.
    pause
    exit /b 1
  )
)

start "" http://localhost:3000
npm start
pause
