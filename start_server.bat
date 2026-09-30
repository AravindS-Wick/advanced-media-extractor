@echo off
title Media Extractor PRO Helper Server
cd /d "%~dp0"
echo ========================================================
echo   Media Extractor PRO - Local Helper Server
echo ========================================================
echo.

where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Python was not found on your system!
    echo Please install Python 3 from https://www.python.org/
    pause
    exit /b 1
)

if not exist ".venv" (
    echo [*] Creating virtual environment in .venv ...
    python -m venv .venv
)

echo [*] Ensuring yt-dlp is installed and up-to-date...
.venv\Scripts\python -m pip install -r server\requirements.txt -q

echo.
echo [*] Helper server listening on http://127.0.0.1:8787
echo [*] Switch to the "1-Click Engine" tab in your Chrome extension!
echo [*] (Keep this command window open while using 1-Click Engine)
echo.
.venv\Scripts\python server\server.py
pause
