# doax CLI launcher for Windows — installed by https://doax.io/install.ps1
# Runs the self-contained CLI bundle (doax.mjs) with Node and passes the exit code through.
$lib = if ($env:DOAX_LIB) { $env:DOAX_LIB } else { Join-Path $HOME ".doax\lib" }
$entry = Join-Path $lib "doax.mjs"

if (-not (Test-Path -LiteralPath $entry)) {
    [Console]::Error.WriteLine("doax: $entry not found. Reinstall with: irm https://doax.io/install.ps1 | iex")
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    [Console]::Error.WriteLine("doax: Node.js is not on PATH. Install it from https://nodejs.org")
    exit 1
}

& node $entry @args
exit $LASTEXITCODE
