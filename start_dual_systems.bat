@echo off
setlocal enabledelayedexpansion
title DUAL SYSTEM MASTER LAUNCHER
echo ==========================================================
echo       Unified Infrastructure - Production Launcher
echo ==========================================================
echo.

:: 1. Infrastructure Cleanup
echo [1/4] Terminating existing services to clear ports...
taskkill /F /IM nginx.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM python.exe >nul 2>&1
echo - NGINX, Node.js, and Python processes terminated.
timeout /t 2 /nobreak >nul

:: 2. Launch VPN Management Backend
echo.
echo [2/4] Starting VPN Backend (Port 5000)...
cd /d "C:\Users\Administrator\Documents\VPN MANAGEMENT SYSTEM\backend"
start "VPN_BACKEND" /min cmd /k "title VPN Backend Engine && node src\server.js"
echo - VPN Backend launched in minimized window.

:: 3. Launch Microsoft Licensing Backend
echo.
echo [3/4] Starting Licensing Backend (Port 8003)...
cd /d "C:\Microsoft-Licensing-system\backend"
if exist "venv\Scripts\activate.bat" (
    start "LICENSING_BACKEND" /min cmd /k "title Licensing Backend (Port 8003) && venv\Scripts\activate && uvicorn server:app --host 0.0.0.0 --port 8003"
    echo - Licensing Backend launched in minimized window.
) else (
    echo [ERROR] Licensing VENV not found at venv\Scripts\activate.bat
    echo Skipping Licensing Backend startup.
)

:: 4. Launch Unified NGINX Gateway
echo.
echo [4/4] Spinning up Unified NGINX Gateway (80/443/444)...
cd /d "C:\Users\Administrator\Documents\VPN MANAGEMENT SYSTEM\nginx-1.28.1"
start "" nginx.exe
echo - NGINX Gateway active with multi-app configuration.

echo.
echo ==========================================================
echo        ALL SYSTEMS SUCCESSFULLY INITIALIZED!
echo ==========================================================
echo.
echo   [VPN PORTAL]
echo   URL: https://localhost:444
echo.
echo   [LICENSING HUB]
echo   URL: http://DCPLCMGRWEB01.secedu.qa (Port 80/443)
echo.
echo ==========================================================
echo NOTE: Keep the minimized backend windows open for services.
echo.
pause
