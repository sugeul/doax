# doax CLI installer for Windows — guide at https://doax.io/install
# Usage (PowerShell): irm https://doax.io/install.ps1 | iex
# Runs inside a script block and never calls `exit`, so piping into iex cannot close your shell.
& {
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"

    $NodeMin = 20
    $Base = if ($env:DOAX_BASE) { $env:DOAX_BASE.TrimEnd("/") } else { "https://doax.io" }
    $BinDir = if ($env:DOAX_BIN) { $env:DOAX_BIN } else { Join-Path $HOME ".doax\bin" }
    $LibDir = if ($env:DOAX_LIB) { $env:DOAX_LIB } else { Join-Path $HOME ".doax\lib" }

    # Windows PowerShell 5.1 may default to TLS 1.0; doax.io requires TLS 1.2.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "doax needs Node.js >= $NodeMin. Install it from https://nodejs.org and re-run." -ForegroundColor Red
        return
    }
    $nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
    if ($nodeMajor -lt $NodeMin) {
        Write-Host "doax needs Node.js >= $NodeMin; found $(& node -v)." -ForegroundColor Red
        return
    }

    New-Item -ItemType Directory -Force -Path $BinDir, $LibDir | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/cli/doax.mjs" -OutFile (Join-Path $LibDir "doax.mjs")
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/doax.ps1" -OutFile (Join-Path $BinDir "doax.ps1")

    # cmd.exe (and PowerShell under a Restricted execution policy) uses this one instead.
    $cmd = "@echo off`r`nnode `"$(Join-Path $LibDir 'doax.mjs')`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $BinDir "doax.cmd"), $cmd, [Text.Encoding]::ASCII)

    # A non-default lib dir must outlive this session so doax.ps1 can find the bundle.
    if ($env:DOAX_LIB) { [Environment]::SetEnvironmentVariable("DOAX_LIB", $LibDir, "User") }

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object { $_ })
    if ($entries -notcontains $BinDir) {
        [Environment]::SetEnvironmentVariable("Path", (($entries + $BinDir) -join ";"), "User")
        Write-Host "added $BinDir to your user PATH (new terminals pick it up)"
    }
    if (($env:Path -split ";") -notcontains $BinDir) { $env:Path = "$env:Path;$BinDir" }

    $version = & node (Join-Path $LibDir "doax.mjs") --version
    Write-Host "installed doax $version -> $BinDir"

    $policy = Get-ExecutionPolicy
    if ($policy -eq "Restricted" -or $policy -eq "AllSigned") {
        Write-Host ""
        Write-Host "Your PowerShell execution policy ($policy) blocks doax.ps1. Either run doax.cmd, or allow local scripts:"
        Write-Host "    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned"
    }

    Write-Host ""
    Write-Host "try:  doax status"
    Write-Host "      doax search slack"
}
