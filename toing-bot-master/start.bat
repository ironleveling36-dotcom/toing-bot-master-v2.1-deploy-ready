@echo off
title Toing Bot Server
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
node start.js
pause
