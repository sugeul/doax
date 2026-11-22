#!/usr/bin/env bash
# Bundles the MCP Gateway Lambda (mcp.doax.io) into a single ESM file for Terraform's archive_file.
# Resolves @doax/* and doax-cli to their TypeScript sources via the `@doax/source` export condition and
# lets esbuild compile them. The AWS SDK v3 is provided by the nodejs22.x runtime, so it is external.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/apps/mcp-gateway/src/lambda.ts"
OUTDIR="$ROOT/infra/terraform/build/mcp-bundle"
OUT="$OUTDIR/index.mjs"

rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

cd "$ROOT/apps/mcp-gateway"
pnpm exec esbuild "$ENTRY" \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node22 \
    --conditions=@doax/source \
    --external:@aws-sdk/* \
    --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
    --outfile="$OUT"

echo "bundled -> $OUT"
