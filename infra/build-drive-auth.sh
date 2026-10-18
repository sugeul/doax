#!/usr/bin/env bash
# Bundles the auth.doax.io drive-auth Lambda (the Google Drive refresh-token mirror) into a
# single ESM file for Terraform's archive_file to zip. Separate from the registry Lambda because
# it runs OUTSIDE the VPC (it needs public egress to accounts.google.com) and is deployed as its
# own function. Same conventions as build-lambda.sh: AWS SDK v3 is runtime-provided (external).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT/apps/doax-server/src/drive-auth.ts"
OUTDIR="$ROOT/infra/terraform/build/drive-auth"
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
    --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
    --outfile="$OUT"

echo "bundled -> $OUT"
