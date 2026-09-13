param([Parameter(Mandatory = $true)][string]$NotesFile)
$ErrorActionPreference = 'Stop'
$notes = (Resolve-Path -LiteralPath $NotesFile).Path
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
$version = (Get-Content -Raw package.json | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use a stable three-part version.' }
$tauriVersion = (Get-Content -Raw src-tauri/tauri.conf.json | ConvertFrom-Json).version
$cargo = Get-Content -Raw src-tauri/Cargo.toml
if ($tauriVersion -ne $version -or $cargo -notmatch ('(?m)^version = "' + [regex]::Escape($version) + '"\r?$')) { throw 'Version mismatch.' }
$dirty = & git status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Commit source changes before releasing.' }
Invoke-Checked 'npx.cmd' @('tsc', '--noEmit', '-p', '.')
Invoke-Checked 'cargo' @('test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib')
Invoke-Checked 'npm.cmd' @('run', 'tauri', 'build', '--', '--', '--locked')
$installer = Get-Item -LiteralPath "src-tauri/target/release/bundle/nsis/Spechy_${version}_x64-setup.exe"
$out = Join-Path $PWD 'src-tauri/target/publish'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$setup = Join-Path $out 'Spechy-Setup.exe'
Copy-Item -LiteralPath $installer.FullName -Destination $setup -Force
$checksum = Join-Path $out 'SHA256SUMS.txt'
((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() + '  Spechy-Setup.exe') | Set-Content -Encoding ascii -LiteralPath $checksum
$tag = "v$version"
Invoke-Checked 'git' @('push', 'origin', 'HEAD')
Invoke-Checked 'git' @('tag', '-a', $tag, '-m', "Spechy $version")
Invoke-Checked 'git' @('push', 'origin', $tag)
Invoke-Checked 'gh' @('release', 'create', $tag, $setup, $checksum, '--repo', 'R-ACU/spechy-releases', '--title', "Spechy $version", '--notes-file', $notes, '--latest')
Invoke-Checked 'gh' @('release', 'create', $tag, $setup, $checksum, '--repo', 'R-ACU/spechy', '--verify-tag', '--title', "Spechy $version", '--notes-file', $notes, '--latest')
