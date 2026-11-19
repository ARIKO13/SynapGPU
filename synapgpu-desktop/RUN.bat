@echo off
REM ============================================================================
REM  SynapGPU Desktop - One-click Runner for Windows
REM ============================================================================
REM  Double-click this file to start SynapGPU Desktop.
REM
REM  What it does:
REM    1. Locates Python 3 on PATH (or auto-installs Python 3.11 if missing)
REM    2. Creates a virtual environment (.venv) on first run
REM    3. Installs dependencies (flask, flask-socketio, psutil, ...) on first run
REM    4. Starts the SynapGPU Desktop server at http://localhost:3000
REM       - app.py auto-opens your default browser
REM    5. CMD window shows live server logs - keep it open while you use the app
REM
REM  Subsequent runs skip steps 1-3 (instant startup).
REM  Close this CMD window (or Ctrl+C) to stop the server.
REM
REM  Requirements: Windows 10+, internet connection on first run.
REM ============================================================================

setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ============================================================
echo   SynapGPU Desktop - Setup ^& Run
echo ============================================================
echo.

REM ---- Step 1: Locate Python 3 ----------------------------------------------
set "PY_CMD="
where py >nul 2>nul && set "PY_CMD=py -3"
if not defined PY_CMD where python >nul 2>nul && set "PY_CMD=python"

if defined PY_CMD (
    REM Verify it's actually Python 3.9+ (flask 3.1.3 needs 3.9+)
    %PY_CMD% -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul
    if errorlevel 1 (
        echo [!] Found Python but it's too old (need 3.9+). Will install fresh.
        set "PY_CMD="
    )
)

if not defined PY_CMD (
    echo [!] Python 3.9+ not found. Downloading Python 3.11.9 from python.org...
    echo     (one-time setup, ~25 MB download)
    echo.
    powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe' -OutFile 'python-installer.exe' -UseBasicParsing } catch { exit 1 }"
    if errorlevel 1 (
        echo [X] Failed to download Python installer.
        echo     Please install Python manually from https://www.python.org/downloads/
        echo     Then run RUN.bat again.
        echo.
        pause
        exit /b 1
    )
    echo [*] Installing Python silently (may take 30-60 seconds)...
    python-installer.exe /passive InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1
    if errorlevel 1 (
        echo [X] Install failed. Try running python-installer.exe manually.
        pause
        exit /b 1
    )
    del python-installer.exe >nul 2>nul
    REM Refresh PATH for the newly installed Python
    set "PATH=%LOCALAPPDATA%\Programs\Python\Python311;%LOCALAPPDATA%\Programs\Python\Python311\Scripts;%PATH%"
    set "PY_CMD=py -3"
    if not exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set "PY_CMD=python"
)

echo [OK] Python ready: %PY_CMD%
%PY_CMD% --version
echo.

REM ---- Step 2: Create virtual environment ----------------------------------
if not exist ".venv\Scripts\activate.bat" (
    echo [*] Creating virtual environment (.venv)...
    %PY_CMD% -m venv .venv
    if errorlevel 1 (
        echo [X] Failed to create venv. Aborting.
        pause
        exit /b 1
    )
    echo [OK] Virtual environment created.
) else (
    echo [OK] Virtual environment already exists - skipping.
)
echo.

REM ---- Step 3: Activate venv + install dependencies ------------------------
call ".venv\Scripts\activate.bat"

if not exist ".venv\.deps_installed" (
    echo [*] Installing dependencies (one-time, ~30 MB)...
    echo     This may take 1-2 minutes. Please be patient.
    echo.
    python -m pip install --upgrade pip >nul 2>nul
    pip install -r requirements.txt
    if errorlevel 1 (
        echo.
        echo [X] Failed to install dependencies.
        echo     Check your internet connection and try again.
        echo     Or install manually: pip install -r requirements.txt
        echo.
        pause
        exit /b 1
    )
    echo done > ".venv\.deps_installed"
    echo [OK] Dependencies installed.
) else (
    echo [OK] Dependencies already installed - skipping.
)
echo.

REM ---- Step 4: Start the server --------------------------------------------
echo ============================================================
echo   Starting SynapGPU Desktop...
echo.
echo   URL:     http://localhost:3000
echo            (browser opens automatically)
echo   To stop: close this window, or press Ctrl+C
echo ============================================================
echo.
echo --- server logs below ---
echo.

python app.py

echo.
echo [*] Server has stopped.
echo.
pause
