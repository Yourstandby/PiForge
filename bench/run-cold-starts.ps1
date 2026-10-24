# PiForge packaged cold-start repeated measurement (isolated userData, does not touch the running app).
#
#   pwsh -NoProfile -File bench/run-cold-starts.ps1 -Runs 3 -GapSec 30
#   powershell -NoProfile -ExecutionPolicy Bypass -File bench/run-cold-starts.ps1 -Runs 3
#
# Each run kills the exe process tree afterwards; main-process logs all go to
# <UserData>\logs\main.log, so afterwards run:
#   python bench/startup_stats.py --log <UserData>\logs\main.log --starts 3
param(
  [string]$Exe = "release\win-unpacked\PiForge.exe",
  [int]$Runs = 3,
  [int]$TimeoutSec = 30,
  [int]$GapSec = 30,
  [string]$UserData = "$env:TEMP\piforge-cold-start-bench",
  [switch]$Keep
)

$ErrorActionPreference = "Stop"
$exePath = (Resolve-Path $Exe).Path
if (-not (Test-Path $UserData)) { New-Item -ItemType Directory -Path $UserData -Force | Out-Null }
$log = Join-Path $UserData "logs\main.log"
if (-not $Keep) { Remove-Item $log -Force -ErrorAction SilentlyContinue }

$env:PIFORGE_USER_DATA = $UserData
Write-Host "exe      : $exePath"
Write-Host "userData : $UserData"
Write-Host "log      : $log"

for ($i = 1; $i -le $Runs; $i++) {
  $before = 0
  if (Test-Path $log) { $before = (Select-String -Path $log -SimpleMatch "agent host ready" -ErrorAction SilentlyContinue | Measure-Object).Count }
  $started = Get-Date
  $proc = Start-Process -FilePath $exePath -PassThru
  $ready = $false
  $deadline = $started.AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if (Test-Path $log) {
      $now = (Select-String -Path $log -SimpleMatch "agent host ready" -ErrorAction SilentlyContinue | Measure-Object).Count
      if ($now -gt $before) { $ready = $true; break }
    }
  }
  $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
  if ($ready) {
    Write-Host ("run {0}: agent host ready after ~{1} ms wall (250ms poll granularity)" -f $i, $elapsed)
  } else {
    Write-Host ("run {0}: TIMEOUT after {1} ms" -f $i, $elapsed)
  }
  Start-Sleep -Seconds 2
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & taskkill /F /T /PID $proc.Id 2>&1 | Out-Null
  $ErrorActionPreference = $prev
  if ($i -lt $Runs) { Start-Sleep -Seconds $GapSec }
}

Write-Host ""
Write-Host "next: python bench/startup_stats.py --log `"$log`" --starts $Runs"
