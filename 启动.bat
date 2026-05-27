@echo off
chcp 65001 > nul
cd /d %~dp0
if not exist node_modules (
  echo Installing deps...
  call npm install
)
call npm start
pause
