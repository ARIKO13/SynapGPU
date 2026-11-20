#!/bin/bash
# Push current local main + create v0.9.0 tag + create GitHub Release.
#
# Usage:
#   GH_TOKEN='ghp_...' bash /home/z/my-project/scripts/push_to_github.sh
#
# Security:
# - The token is read from the GH_TOKEN env var, NEVER echoed or logged.
# - Any git/curl output that might contain the token is scrubbed via sed.
# - The token is NOT written to .git/config (no `git remote add` with creds).
# - A clean remote (no credentials) is set up afterwards for future use.
set -uo pipefail
set +o history  # don't record this session in bash history

if [ -z "${GH_TOKEN:-}" ]; then
  echo "ERROR: GH_TOKEN env var not set"
  exit 1
fi

cd /home/z/my-project

# Scrub helper: replace the token with *** in any output
scrub() {
  sed "s|${GH_TOKEN}|***|g; s|x-access-token:[^@]*@|x-access-token:***@|g; s|token [A-Za-z0-9_]*|token ***|g"
}

REMOTE_URL="https://github.com/ARIKO13/SynapGPU.git"
AUTH_URL="https://x-access-token:${GH_TOKEN}@github.com/ARIKO13/SynapGPU.git"

echo "=== 1. Status before commit ==="
git status --short | head -20

echo ""
echo "=== 2. Committing pending changes ==="
git add -A
git commit -m "v0.9.0: dashboard offline handling + pretrained/trained UI + source download endpoint

- synapgpu-desktop: dashboard offline panel + auto-select .gguf on drop
- web preview: GET /api/files on mount restores sidebar after reload
- chat-tester: persist trainedModel to localStorage; honest disclaimer
  that web chat uses GLM via ZAI SDK, not the uploaded .gguf
- platform-header: primary Download serves source zip from
  /api/download/desktop; secondary link to GitHub releases (v0.8.0)
- next.config: socket.io polling proxy + allowedDevOrigins
- new endpoint: /api/download/desktop zips latest source on-the-fly" \
  --allow-empty 2>&1 | tail -5

echo ""
echo "=== 3. Remote state before push (public read) ==="
git ls-remote "$REMOTE_URL" 2>&1 | head -10 | scrub

echo ""
echo "=== 4. Local HEAD ==="
git rev-parse HEAD
git log --oneline -3

echo ""
echo "=== 5. Pushing main (force, since local diverged from v0.8.0) ==="
git push "$AUTH_URL" main:main --force 2>&1 | scrub

echo ""
echo "=== 6. Tagging v0.9.0 ==="
git tag -d v0.9.0 2>/dev/null || true
git tag -a v0.9.0 -m "v0.9.0: dashboard offline + pretrained/trained UI + source download endpoint"
git push "$AUTH_URL" v0.9.0 2>&1 | scrub

echo ""
echo "=== 7. Creating GitHub Release v0.9.0 (so it shows as 'latest') ==="
RELEASE_BODY=$(cat <<'JSON'
{
  "tag_name": "v0.9.0",
  "name": "v0.9.0 — Dashboard offline + pretrained/trained UI + source download",
  "body": "## What's new\n\n- Dashboard offline handling: shows an offline panel when the telemetry socket disconnects (instead of forever \"Connecting…\")\n- Auto-select .gguf in the Pre-trained dropdown when a file is dropped into the sidebar\n- Pre-trained vs Trained model modes in the Test LLM tab\n- Trained model state persists in localStorage across page reloads\n- File list restored from the server after a page reload (no more empty sidebar on refresh)\n- Honest chat disclaimer: the web preview uses GLM via z-ai-web-dev-sdk, NOT the uploaded .gguf file. For real .gguf inference, run SynapGPU Desktop.\n- Download Desktop button now serves the latest source code zip from /api/download/desktop (always has the freshest fixes)\n\n## Install from source\n\n```bash\nunzip SynapGPU-Desktop-latest.zip -d synapgpu-desktop\ncd synapgpu-desktop\npip install -r requirements.txt\npython app.py\n```\n\nPre-built Windows .exe will be uploaded separately once built on a Windows machine.",
  "draft": false,
  "prerelease": false
}
JSON
)
curl -sS -X POST \
  -H "Authorization: token ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/ARIKO13/SynapGPU/releases \
  -d "$RELEASE_BODY" \
  2>&1 | scrub | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    if 'html_url' in d:
        print('Release created:', d.get('html_url'))
        print('Tag:', d.get('tag_name'), '| Draft:', d.get('draft'), '| Prerelease:', d.get('prerelease'))
    elif 'message' in d:
        print('API error:', d.get('message'))
        if 'errors' in d:
            print('Detail:', d['errors'])
    else:
        print('Unexpected response')
except Exception as e:
    print('Parse error:', e)
"

echo ""
echo "=== 8. Setting up clean remote (no credentials stored) ==="
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE_URL"
git remote -v

echo ""
echo "=== 9. Verify remote main matches local HEAD ==="
REMOTE_MAIN=$(git ls-remote "$REMOTE_URL" main 2>&1 | awk '{print $1}' | head -1)
LOCAL_HEAD=$(git rev-parse HEAD)
echo "Remote main: $REMOTE_MAIN"
echo "Local HEAD:  $LOCAL_HEAD"
if [ "$REMOTE_MAIN" = "$LOCAL_HEAD" ]; then
  echo "✓ MATCH — push succeeded"
else
  echo "✗ MISMATCH — push may have failed"
fi

echo ""
echo "=== 10. Verify v0.9.0 tag is on remote ==="
git ls-remote "$REMOTE_URL" v0.9.0 2>&1 | scrub

echo ""
echo "=== DONE ==="
