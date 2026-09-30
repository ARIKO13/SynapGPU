#!/bin/bash
# SynapGPU Desktop — PyInstaller build script (macOS / Linux)
#
# Produces a dist/SynapGPU/ folder with the executable + bundled deps.
# Distribute the entire folder to end users.

set -e

cd "$(dirname "$0")"

echo "==> Cleaning previous builds"
rm -rf build dist

echo "==> Installing dependencies"
pip install -r requirements.txt

echo "==> Building with PyInstaller"
pyinstaller SynapGPU.spec --noconfirm --clean

echo ""
echo "==> Build complete!"
echo "    Output: dist/SynapGPU/"
echo "    Run:    ./dist/SynapGPU/SynapGPU"
echo ""
echo "To distribute: zip the dist/SynapGPU/ folder and share it."
echo "Users just need to extract and double-click SynapGPU."
