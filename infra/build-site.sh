#!/usr/bin/env bash
# Builds everything the doax.io website bucket serves:
#   index.html   — the landing page (infra/site/doax-site.html wrapped in a document shell)
#   install.html — the CLI install guide (served at /install)
#   install.sh   — the one-liner installer (Linux/macOS)
#   install.ps1  — the one-liner installer (Windows PowerShell)
#   doax.ps1     — the Windows launcher install.ps1 puts on PATH
#   cli/doax.mjs — the CLI as one self-contained ESM bundle (Node >= 20)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/infra/terraform/build/site"
mkdir -p "$OUT/cli"

{
    printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="description" content="doax — the global registry of data and action resources that AI agents use on behalf of a human.">\n</head>\n<body>\n'
    cat "$ROOT/infra/site/doax-site.html"
    printf '\n</body>\n</html>\n'
} > "$OUT/index.html"

cp "$ROOT/infra/site/install.html" "$OUT/install.html"
cp "$ROOT/infra/site/install.sh" "$OUT/install.sh"
cp "$ROOT/infra/site/install.ps1" "$OUT/install.ps1"
cp "$ROOT/infra/site/doax.ps1" "$OUT/doax.ps1"

# Render the playbooks (playbook/**) into one page served at /playbook
node "$ROOT/infra/build-playbook.mjs"

cd "$ROOT"
pnpm -w exec esbuild "$ROOT/apps/doax-cli/src/main.ts" \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node20 \
    --conditions=@doax/source \
    --outfile="$OUT/cli/doax.mjs" \
    --log-level=warning

echo "site build -> $OUT"
ls -la "$OUT" "$OUT/cli"
