#!/usr/bin/env bash
# Bundles the registry-API Lambda (one of the global registry's professional services)
# into a single ESM file for Terraform's archive_file to zip.
#
# Resolves @doax/* workspace packages to their TypeScript sources via the `@doax/source`
# export condition and lets esbuild compile them. The AWS SDK v3 is provided by the
# nodejs22.x runtime, so it is marked external; `pg` is bundled.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/apps/doax-server/src/lambda.ts"
OUTDIR="$ROOT/infra/terraform/build/bundle"
OUT="$OUTDIR/index.mjs"

rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

cd "$ROOT/apps/doax-server"
pnpm exec esbuild "$ENTRY" \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node22 \
    --conditions=@doax/source \
    --external:@aws-sdk/* \
    --external:pg-native \
    --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
    --outfile="$OUT"

echo "bundled -> $OUT"
