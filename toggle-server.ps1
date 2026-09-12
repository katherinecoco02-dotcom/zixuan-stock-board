<#
  自选股看板 · 服务开关
  ------------------------------------------------------------------
  双击桌面「自选股看板 开关」运行本脚本：
     服务未运行 → 启动它，并自动打开浏览器
     服务已运行 → 停止它

  判定"服务在不在跑"以 **HTTP 健康检查**为准，而不是看端口。
  原因：在本机上实测 Get-NetTCPConnection / netstat 看不到沙箱进程的监听端口，
  只看端口会误判成"没在运行"，于是重复启动 → 端口冲突 → 新进程绑定失败，
  但健康检查被旧实例应答，脚本却显示"已启动"，用户从此关不掉服务。

  停止服务时按以下顺序定位进程：PID 文件 → 端口 → 命令行匹配。
  PID 文件由本脚本启动时写入，因此"脚本启动的服务"总能被可靠停止。

  参数：
     -Port <n>   服务端口，默认 8787
     -Open       确保服务在跑并打开浏览器，不停止（幂等）
     -NoUi       不弹窗、不开浏览器，只往控制台输出（供自动化/排查用）
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$Open,
  [switch]$NoUi
)

$Root      = $PSScriptRoot
$Url       = "http://127.0.0.1:$Port"
$ServerJs  = Join-Path $Root 'server.mjs'
$DataDir   = Join-Path $Root 'data'
$PidFile   = Join-Path $DataDir 'server.pid'
$LogOut    = Join-Path $DataDir 'server.log'
$LogErr    = Join-Path $DataDir 'server.err.log'
$LogToggle = Join-Path $DataDir 'toggle.log'

function Write-ToggleLog([string]$text) {
  try {
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }
    Add-Content -LiteralPath $LogToggle -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text) -Encoding UTF8
  } catch { }
}

function Show-Result([string]$text, [string]$kind = 'Info') {
  Write-ToggleLog ("{0} :: {1}" -f $kind, ($text -replace "`r?`n", ' / '))
  if ($NoUi) { Write-Host $text; return }
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $icon = switch ($kind) { 'Error' { 'Error' } 'Warn' { 'Warning' } default { 'Information' } }
    [System.Windows.Forms.MessageBox]::Show($text, '自选股看板', 'OK', $icon) | Out-Null
  } catch {
    Write-Host $text
  }
}

# --- 找 node：不能依赖 PATH，本机 node 来自 DSH 自带的运行时 ---
function Resolve-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }

  $dsh = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'DeepSeekHarness') -Filter 'node.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue |
         Select-Object -First 1
  if ($dsh) { return $dsh.FullName }

  $candidates = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

# --- 权威判据：服务是否真的在响应 ---
function Test-Health([int]$p) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/health" -TimeoutSec 3
    return [bool]$r.ok
  } catch { return $false }
}

# --- 定位看板进程（多路兜底，任一路失败不影响其他） ---
function Find-BoardPids([int]$p) {
  $found = New-Object System.Collections.Generic.List[int]

  # 1) PID 文件（最可靠：本脚本启动时写入）
  if (Test-Path $PidFile) {
    $raw = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $n = 0
    if ([int]::TryParse($raw, [ref]$n) -and $n -gt 0) {
      $proc = Get-Process -Id $n -ErrorAction SilentlyContinue
      # 只认 node，避免 PID 被系统回收后误杀别的程序
      if ($proc -and $proc.ProcessName -eq 'node') { $found.Add($n) }
    }
  }

  # 2) 端口
  try {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c -and $c.OwningProcess) { $found.Add([int]$c.OwningProcess) }
  } catch { }
  try {
    $lines = netstat -ano | Select-String -Pattern ":$p\s" | Select-String -Pattern 'LISTENING'
    foreach ($l in $lines) {
      $parts = $l.ToString().Trim() -split '\s+'
      $n = 0
      if ([int]::TryParse($parts[-1], [ref]$n) -and $n -gt 0) { $found.Add($n) }
    }
  } catch { }

  # 3) 命令行匹配（沙箱下可能被拒，故放最后且不报错）
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
    foreach ($pr in $procs) {
      if ($pr.CommandLine -and $pr.CommandLine -match 'server\.mjs') { $found.Add([int]$pr.ProcessId) }
    }
  } catch { }

  return ($found | Sort-Object -Unique)
}

function Start-Board {
  if (-not (Test-Path $ServerJs)) {
    Show-Result "找不到 server.mjs：`n$ServerJs" 'Error'
    return $false
  }
  $node = Resolve-Node
  if (-not $node) {
    Show-Result "找不到 node.exe。`n请确认 Node.js 已安装，或手动把路径写进脚本的 Resolve-Node。" 'Error'
    return $false
  }
  if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }

  Write-ToggleLog "启动：node=$node"
  try {
    $proc = Start-Process -FilePath $node `
      -ArgumentList 'server.mjs' `
      -WorkingDirectory $Root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $LogOut `
      -RedirectStandardError $LogErr `
      -PassThru
  } catch {
    Show-Result "启动失败：`n$($_.Exception.Message)" 'Error'
    return $false
  }

  Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding ASCII
  Write-ToggleLog "PID=$($proc.Id) 已写入 $PidFile"

  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Health -p $Port) { return $true }
  }
  return $false
}

function Stop-Board([int[]]$pids) {
  $killed = New-Object System.Collections.Generic.List[int]
  foreach ($procId in $pids) {
    try {
      Stop-Process -Id $procId -Force -ErrorAction Stop
      $killed.Add($procId)
    } catch {
      Write-ToggleLog "停止 PID $procId 失败：$($_.Exception.Message)"
    }
  }
  # 等它真正不再响应
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Test-Health -p $Port)) { break }
  }
  if (Test-Path $PidFile) { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue }
  return $killed
}

# ---------------------------------------------------------------- 主流程

if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Force -Path $DataDir | Out-Null }

$running = Test-Health -p $Port
$boardPids = Find-BoardPids -p $Port
$pidText = '无'
if ($boardPids -and $boardPids.Count -gt 0) { $pidText = ($boardPids -join ',') }
Write-ToggleLog ("状态检查：health={0} 定位到进程={1}" -f $running, $pidText)

if ($Open) {
  if (-not $running) {
    if (-not (Start-Board)) { Show-Result "启动失败，请看日志：`n$LogErr" 'Error'; exit 1 }
  }
  if (-not $NoUi) { Start-Process $Url }
  Show-Result "看板已就绪：`n$Url"
  exit 0
}

if ($running -or ($boardPids -and $boardPids.Count -gt 0)) {
  # ---- 已在运行 → 停止
  if (-not $boardPids -or $boardPids.Count -eq 0) {
    Show-Result "检测到看板在响应，但定位不到它的进程。`n`n它可能由别的程序启动。`n请手动结束 node 进程，或重启电脑。" 'Warn'
    exit 1
  }
  $killed = Stop-Board -pids $boardPids
  if (Test-Health -p $Port) {
    Show-Result "已尝试停止（PID $($killed -join ',')），但服务仍在响应。`n可稍等几秒再点一次。" 'Warn'
    exit 1
  }
  Show-Result "看板服务已停止。`n`n（已结束 PID $($killed -join ',')）`n需要时再双击本开关即可重新启动。"
  exit 0
}

# ---- 未运行 → 启动
if (-not (Start-Board)) {
  Show-Result "启动失败。`n`n常见原因：端口 $Port 被别的程序占用。`n日志：`n$LogErr" 'Error'
  exit 1
}

if (-not $NoUi) { Start-Process $Url }
Show-Result "看板服务已启动。`n`n$Url`n`n浏览器已打开；再次双击本开关可停止服务。"
exit 0
