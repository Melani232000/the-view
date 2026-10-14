@echo off
cd /d "%~dp0"
echo Instalando dependencias...
call npm.cmd install
echo.
echo Iniciando THE VIEW en http://localhost:3000
start "" http://localhost:3000
call npm.cmd start
pause
