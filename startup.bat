@echo off
cd /d "%~dp0"
start "" http://localhost:3113
npm run dev
