# -*- mode: python ; coding: utf-8 -*-
# SynapGPU Desktop — PyInstaller spec file
#
# Bundles the Flask app + static assets into a standalone executable.
# Output: dist/SynapGPU/SynapGPU (Linux/macOS) or dist/SynapGPU/SynapGPU.exe (Windows)

block_cipher = None

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        # Bundle the static folder so the executable can serve HTML/CSS/JS
        ('static', 'static'),
    ],
    hiddenimports=[
        # Flask-SocketIO's async modes — bundle all to be safe
        'simple_websocket',
        'engineio.async_drivers.threading',
        # psutil optional but recommended
        'psutil',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Trim unused heavy modules to reduce binary size
        'tkinter',
        'unittest',
        'pydoc',
        'doctest',
        'argparse',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='SynapGPU',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,  # Keep console open so users see logs / errors
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='SynapGPU',
)
