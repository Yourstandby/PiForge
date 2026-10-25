<#
  PiForge codemode 热修复（Windows / PowerShell 5.1+）
  作用：给已发布的安装补上 standalone\agent-host\codemode-worker.js 及其相对依赖。
  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File hotfix-codemode.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File hotfix-codemode.ps1 -AppDir "D:\Pi\PiFo\1\PiForge-0.10.0-win-x64"
#>
param(
  [Parameter(Position = 0)]
  [string]$AppDir = ''
)

$ErrorActionPreference = 'Stop'
$WorkerName = 'codemode-worker.js'
$RelImport = '(?:from\s*|import\s*\(\s*|new\s+URL\(\s*)[''"](\.[^''"]+)[''"]'

function Find-Resources([string]$root) {
  if ([string]::IsNullOrWhiteSpace($root)) { return $null }
  foreach ($rel in @('resources', 'Contents/Resources')) {
    $res = Join-Path $root $rel
    if (Test-Path -LiteralPath (Join-Path $res 'standalone')) { return (Resolve-Path -LiteralPath $res).Path }
  }
  return $null
}

$roots = New-Object System.Collections.Generic.List[string]
if ($AppDir) { $roots.Add($AppDir) }
$localAppData = $env:LOCALAPPDATA
$programFiles = $env:ProgramFiles
$programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
if ($localAppData) { $roots.Add((Join-Path $localAppData 'Programs\PiForge')) }
if ($programFiles) { $roots.Add((Join-Path $programFiles 'PiForge')) }
if ($programFilesX86) { $roots.Add((Join-Path $programFilesX86 'PiForge')) }

$found = @()
foreach ($root in $roots) {
  $res = Find-Resources $root
  if ($res -and -not ($found | Where-Object { $_.Resources -eq $res })) {
    $found += [pscustomobject]@{ Root = $root; Resources = $res }
  }
}

if ($found.Count -eq 0) {
  Write-Host '[hotfix] 没找到 PiForge 安装目录。请用 -AppDir 指定安装根目录。' -ForegroundColor Yellow
  exit 1
}

foreach ($item in $found) {
  $res = $item.Resources
  $hostDir = Join-Path $res 'standalone\agent-host'
  if (-not (Test-Path -LiteralPath $hostDir)) {
    Write-Host ('[hotfix] 跳过 ' + $item.Root + '：缺少 standalone\agent-host') -ForegroundColor Yellow
    continue
  }

  $piPkg = Join-Path $res 'standalone\node_modules\@earendil-works\pi-coding-agent'
  $src = $null
  if (Test-Path -LiteralPath $piPkg) {
    $src = Get-ChildItem -LiteralPath $piPkg -Recurse -File -Filter $WorkerName -ErrorAction SilentlyContinue |
      Select-Object -First 1
  }
  if (-not $src) {
    Write-Host ('[hotfix] 跳过 ' + $item.Root + '：安装里找不到 ' + $WorkerName + '（可能已是修复版）') -ForegroundColor Yellow
    continue
  }

  # worker 若是被拆分的产物，会相对引用同目录其它 chunk，按闭包一并搬运
  $queue = New-Object System.Collections.Queue
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $files = New-Object System.Collections.Generic.List[string]
  $queue.Enqueue($src.FullName)
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    if (-not $seen.Add($cur)) { continue }
    if (-not [System.IO.File]::Exists($cur)) { continue }
    $files.Add($cur)
    $text = Get-Content -LiteralPath $cur -Raw
    foreach ($m in [regex]::Matches($text, $RelImport)) {
      $basePath = Join-Path ([System.IO.Path]::GetDirectoryName($cur)) $m.Groups[1].Value
      foreach ($cand in @($basePath, ($basePath + '.js'), ($basePath + '.mjs'), (Join-Path $basePath 'index.js'))) {
        if ([System.IO.File]::Exists($cand)) {
          $queue.Enqueue((Resolve-Path -LiteralPath $cand).Path)
          break
        }
      }
    }
  }

  foreach ($file in $files) {
    Copy-Item -LiteralPath $file -Destination (Join-Path $hostDir ([System.IO.Path]::GetFileName($file))) -Force
  }

  $target = Join-Path $hostDir $WorkerName
  if (-not (Test-Path -LiteralPath $target)) {
    throw ('[hotfix] 复制后仍缺少 ' + $WorkerName + '：' + $hostDir)
  }
  Write-Host ('[hotfix] OK  ' + $files.Count + ' 个文件 -> agent-host\  (' + $item.Root + ')') -ForegroundColor Green
}

Write-Host ''
Write-Host '[hotfix] 完成。无需重装；重新发起一次带工具调用的会话即可验证。' -ForegroundColor Green
Write-Host '[hotfix] 注意：重装或自动更新会覆盖本补丁，需升级到含修复的版本。' -ForegroundColor DarkGray
