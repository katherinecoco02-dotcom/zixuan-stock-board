<#
  自选股看板 · 一键安装
  ==================================================================
  在目标机器上双击「安装.cmd」即可（不要直接双击本 .ps1，那样不会执行）。
  本脚本会：
    1. 检查 Node.js（没有就问你装不装）
    2. 让你填自己的同花顺 API Key，并**当场联网验证**能不能用
    3. 在桌面创建「自选股看板 开关」快捷方式与「自选股看板」链接
    4. 问你要不要立刻启动

  参数（一般用不到）：
    -ApiKey <key>   直接提供 Key，跳过交互
    -NoDesktop      不创建桌面快捷方式
    -NoStart        装完不启动
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$ApiKey,
  [switch]$NoDesktop,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 默认可能还在用 TLS 1.0，连不上 https
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Root      = $PSScriptRoot
$Toggle    = Join-Path $Root 'toggle-server.ps1'
$ServerJs  = Join-Path $Root 'server.mjs'
$KeyFile   = Join-Path $Root '.apikey'
$Url       = 'http://127.0.0.1:8787'
$ApiBase   = 'https://fuyao.aicubes.cn'

function Say([string]$t, [string]$color = 'Gray') { Write-Host $t -ForegroundColor $color }
function Ok([string]$t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Bad([string]$t)  { Write-Host "  [失败] $t" -ForegroundColor Red }
function Warn([string]$t) { Write-Host "  [注意] $t" -ForegroundColor Yellow }
function Step([string]$t) { Write-Host "`n== $t" -ForegroundColor Cyan }

Say "===============================================" Cyan
Say "        自选股看板 · 一键安装" Cyan
Say "===============================================" Cyan
Say "安装位置：$Root"

# ---------------------------------------------------------------- 1) Node.js
Step "1/4  检查 Node.js"

function Resolve-NodeExe {
  $c = Get-Command node -ErrorAction SilentlyContinue
  if ($c -and $c.Source) { return $c.Source }
  foreach ($p in @(
      (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

$node = Resolve-NodeExe
if (-not $node) {
  Warn "没有找到 Node.js，看板需要它才能运行。"
  $hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
  if ($hasWinget) {
    $ans = Read-Host "  现在用 winget 自动安装 Node.js LTS 吗？(Y/N)"
    if ($ans -match '^[Yy]') {
      Say "  正在安装（可能要几分钟，会弹出系统授权窗口）..."
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      $node = Resolve-NodeExe
    }
  } else {
    Say "  请先手动安装：https://nodejs.org/  （下载 LTS 版，一路下一步即可）"
  }
  if (-not $node) {
    Bad "Node.js 仍未就绪，安装中止。装好后重新运行本安装程序即可。"
    exit 1
  }
}
$ver = (& $node -v) 2>&1
Ok "Node.js $ver  ($node)"

# ---------------------------------------------------------------- 2) API Key
Step "2/4  配置 API Key"

function Normalize-Key([string]$raw) {
  if (-not $raw) { return '' }
  return ($raw -split "`r?`n")[0].Trim().Trim('"').Trim("'")
}

$key = Normalize-Key $ApiKey
if (-not $key -and (Test-Path $KeyFile)) {
  $existing = Normalize-Key (Get-Content -LiteralPath $KeyFile -Raw -ErrorAction SilentlyContinue)
  if ($existing -and $existing -notmatch '^<|粘贴|在此') {
    Ok "已存在 .apikey，沿用现有 Key（如需更换，删掉该文件后重跑本程序）"
    $key = $existing
  }
}

if (-not $key) {
  Say "  看板要连「同花顺金融数据服务」，需要你自己的 API Key（与同花顺账号绑定，每人一把）。"
  Say "  获取步骤："
  Say "    1) 打开 $ApiBase/login/  用同花顺账号登录（没有就先注册）"
  Say "    2) 进 $ApiBase/admin/  点「创建 API Key」"
  Say "    3) 弹窗里的 Key 只显示一次，立刻复制，粘到下面"
  Say ""
  $key = Normalize-Key (Read-Host "  请粘贴 API Key（直接回车=跳过）")
}

if (-not $key) {
  Warn "没有提供 Key，看板装好也取不到数据。"
  Say "  可以之后再手动把 Key 写进：$KeyFile"
} else {
  Say "  正在联网验证这个 Key ..."
  $verified = $false
  try {
    $r = Invoke-RestMethod -Uri "$ApiBase/api/a-share/calendar/trading-days" `
      -Headers @{ 'X-api-key' = $key } -TimeoutSec 20
    if ($r.code -eq 0) {
      $n = ($r.data.item | Measure-Object).Count
      Ok "Key 验证通过（取到 $n 个交易日）"
      $verified = $true
    } else {
      Bad "Key 被拒绝：code=$($r.code) $($r.message)"
    }
  } catch {
    Warn "联网验证没成功：$($_.Exception.Message)"
    Warn "可能是网络问题。Key 仍会保存，联网正常后应可用。"
  }

  if ($verified -or $key) {
    # .apikey 只放 Key 一行，UTF-8 无 BOM（Node 读取最稳）
    [System.IO.File]::WriteAllText($KeyFile, $key + "`n", (New-Object System.Text.UTF8Encoding $false))
    Ok "已写入 $KeyFile"
  }
}

# ---------------------------------------------------------------- 3) 桌面快捷方式
Step "3/4  创建桌面快捷方式"

if ($NoDesktop) {
  Say "  已按要求跳过"
} else {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop -or -not (Test-Path $desktop)) {
    Warn "找不到桌面目录，跳过"
  } else {
    # 3a) .lnk —— Unicode 路径安全，优先
    $lnkMade = $false
    try {
      $ws = New-Object -ComObject WScript.Shell
      $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $lnk = $ws.CreateShortcut((Join-Path $desktop '自选股看板 开关.lnk'))
      $lnk.TargetPath = $psExe
      $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Toggle`""
      $lnk.WorkingDirectory = $Root
      $lnk.Description = '启动 / 停止 自选股看板服务'
      $lnk.IconLocation = "$psExe,0"
      $lnk.Save()
      $lnkMade = $true
      Ok "已创建「自选股看板 开关」快捷方式"
    } catch {
      Warn "创建 .lnk 失败（$($_.Exception.Message)），改用 .cmd 兜底"
    }

    # 3b) .cmd 兜底 —— 用系统 OEM 代码页写，cmd.exe 才能正确解析中文路径
    if (-not $lnkMade) {
      try {
        $oem = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
        $cmdText = @"
@echo off
rem 自选股看板 · 服务开关（双击运行；服务没开就启动，已开就停止）
powershell -NoProfile -ExecutionPolicy Bypass -File "$Toggle"
echo.
echo 按任意键关闭本窗口...
pause >nul
"@
        [System.IO.File]::WriteAllText((Join-Path $desktop '自选股看板 开关.cmd'), $cmdText, $oem)
        Ok "已创建「自选股看板 开关.cmd」"
      } catch {
        Bad "创建 .cmd 也失败了：$($_.Exception.Message)"
      }
    }

    # 3c) 地址链接
    try {
      $urlFile = Join-Path $desktop '自选股看板.url'
      [System.IO.File]::WriteAllText($urlFile, "[InternetShortcut]`r`nURL=$Url/`r`n", [System.Text.Encoding]::ASCII)
      Ok "已创建「自选股看板」链接"
    } catch {
      Warn "创建链接失败：$($_.Exception.Message)"
    }
  }
}

# ---------------------------------------------------------------- 4) 试运行
Step "4/4  试运行"

if ($NoStart) {
  Say "  已按要求跳过。之后双击桌面「自选股看板 开关」即可启动。"
} else {
  $ans = Read-Host "  现在启动看板吗？(Y/N)"
  if ($ans -match '^[Yy]') {
    Say "  正在启动 ..."
    & powershell -NoProfile -ExecutionPolicy Bypass -File $Toggle -NoUi
    Start-Sleep -Milliseconds 500
    try {
      $h = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 8
      if ($h.ok) { Ok "看板已启动：$Url" } else { Warn "服务起来了但健康检查异常" }
    } catch {
      Warn "启动后未能连上，可查看 $Root\data\server.err.log"
    }
  } else {
    Say "  好的，之后双击桌面「自选股看板 开关」即可启动。"
  }
}

Say ""
Say "===============================================" Green
Say " 安装完成" Green
Say "===============================================" Green
Say "  打开看板：双击桌面的「自选股看板」"
Say "  启动/停止服务：双击桌面的「自选股看板 开关」（在跑就停，没跑就开）"
Say "  使用说明：$Root\README.md"
Say ""
Say "  注意：服务关掉后看板就打不开了，这是正常的 —— 需要时点一下开关即可。"
