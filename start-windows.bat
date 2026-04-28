@echo off
cd /d "%~dp0"
set PUPPETEER_SKIP_DOWNLOAD=true
npm install --ignore-scripts --no-audit --no-fund
npm start
pause
