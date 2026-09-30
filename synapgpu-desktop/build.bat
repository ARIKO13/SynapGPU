@echo off
REM SynapGPU Desktop - PyInstaller build script (Windows)
REM Produces a dist\SynapGPU\ folder with SynapGPU.exe + bundled deps.

cd /d "%~dp0"

echo ==^> Cleaning previous builds
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo ==^> Installing dependencies
pip install -r requirements.txt

echo ==^> Building with PyInstaller
pyinstaller SynapGPU.spec --noconfirm --clean

echo.
echo ==^> Build complete!
echo     Output: dist\SynapGPU\
echo     Run:    dist\SynapGPU\SynapGPU.exe
echo.
echo To distribute: zip the dist\SynapGPU\ folder and share it.
echo Users just need to extract and double-click SynapGPU.exe.
pause
