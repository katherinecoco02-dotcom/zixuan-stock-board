<#
  把本仓库推到 GitHub
  ==================================================================
  用法：
    1. 到 https://github.com/settings/tokens 生成一枚 classic token（勾 repo 权限）
    2. 把 token 贴进本目录的 .git-token（单行，无引号；该文件已被 .gitignore 忽略）
    3. 运行：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\push-to-github.ps1

  做的事：读 token → 取用户名 → 仓库不存在就建 → 设置 origin → 推送 main
  安全：全程不打印 token。推送时把 token 放在**一次性 URL**里，
        推完把 origin 重置成不含 token 的干净地址，所以 token 不会留在 .git/config。

  参数：
    -RepoName <名>   仓库名，默认 zixuan-stock-board
    -Private         建成私有仓库（默认公开）
    -SkipCreate      跳过建仓（仓库已存在时用）
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$RepoName = 'zixuan-stock-board',
  [switch]$Private,
  [switch]$SkipCreate
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Say([string]$t, [string]$c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Ok([string]$t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Bad([string]$t)  { Write-Host "  [失败] $t" -ForegroundColor Red }
function Warn([string]$t) { Write-Host "  [注意] $t" -ForegroundColor Yellow }

$Root      = Split-Path -Parent $PSScriptRoot
$TokenFile = Join-Path $Root '.git-token'

# ---------------------------------------------------------------- 找 git
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) {
  foreach ($p in @(
      (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd\git.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe')
    )) { if ($p -and (Test-Path $p)) { $git = $p; break } }
}
if (-not $git) { Bad "找不到 git.exe，请先安装 Git for Windows：https://git-scm.com/"; exit 1 }
Ok "git: $git"

# ---------------------------------------------------------------- 读 token
if (-not (Test-Path $TokenFile)) {
  Bad "找不到 $TokenFile"
  Say "  请先把 GitHub token 写进该文件（单行，无引号）。"
  Say "  生成地址：https://github.com/settings/tokens  （classic，勾 repo）"
  exit 1
}
$token = ((Get-Content -LiteralPath $TokenFile -Raw) -split "`r?`n")[0].Trim()
if (-not $token) { Bad "$TokenFile 是空的"; exit 1 }
Ok ("已读取 token（" + $token.Length + " 字符，不显示内容）")

$headers = @{
  Authorization = "Bearer $token"
  Accept        = 'application/vnd.github+json'
  'User-Agent'  = 'zixuan-stock-board-push'
}

# ---------------------------------------------------------------- 取用户名
try {
  $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers -TimeoutSec 30
} catch {
  # 不要把任何异常都当成"token 无效" —— 受限环境里 .NET 的 TLS 可能连不上 GitHub，
  # 那时 token 其实没问题（本机就踩过这个坑）。据实区分。
  $msg = $_.Exception.Message
  if ($msg -match '基础连接|TLS|SSL|schannel|超时|timeout|无法连接|name resolution|远程名称') {
    Bad "连不上 api.github.com —— 这是网络/TLS 问题，不是 token 的问题：$msg"
    Say "  办法一：在网页手工建好仓库，再用 -SkipCreate 参数只做推送"
    Say "          （推送走 git 自己的 TLS，通常不受影响）"
    Say "  办法二：若 git 报 schannel SEC_E_NO_CREDENTIALS，给本仓库换 OpenSSL 后端："
    Say "          git config --local http.sslBackend openssl"
  } else {
    Bad "token 无效或无权访问 GitHub API：$msg"
    Say "  常见原因：token 过期、未勾 repo 权限、或已被撤销。"
  }
  exit 1
}
$login = $me.login
Ok "已认证为：$login"

$full = "$login/$RepoName"

# ---------------------------------------------------------------- 建仓库
if (-not $SkipCreate) {
  $exists = $false
  try {
    $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$full" -Headers $headers -TimeoutSec 30
    $exists = $true
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) {
      Warn "查询仓库时出错（$($_.Exception.Message)），仍尝试创建"
    }
  }

  if ($exists) {
    Ok "仓库已存在：$full（跳过创建）"
  } else {
    $body = @{
      name        = $RepoName
      description = '自选股看板 —— 基于同花顺金融数据服务的本地 A 股看板：自选股列表+K线、四宫格、盘面复盘、选股筛选、策略回测、价格预警'
      private     = [bool]$Private
      has_issues  = $true
      has_wiki    = $false
    } | ConvertTo-Json
    try {
      $repo = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 30
      Ok "已创建仓库：$($repo.full_name)  ($(if ($Private) { '私有' } else { '公开' }))"
    } catch {
      Bad "创建仓库失败：$($_.Exception.Message)"
      $detail = $_.ErrorDetails.Message
      if ($detail) { Say "  接口返回：$detail" }
      Say "  若提示权限不足，请确认 token 勾了 repo 权限（classic）。"
      exit 1
    }
  }
}

# ---------------------------------------------------------------- 推送
& $git -C $Root rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) { Bad "$Root 不是 git 仓库"; exit 1 }

$branch = (& $git -C $Root rev-parse --abbrev-ref HEAD).Trim()
Ok "当前分支：$branch"

# 先把 origin 设成干净地址（不含 token），推送时再用一次性 URL
& $git -C $Root remote remove origin 2>$null | Out-Null
& $git -C $Root remote add origin "https://github.com/$full.git"

Say "  正在推送（首次会传全部文件）..."
# 用一次性 URL 推送：token 不进 .git/config，也不会留在 remote 里。
# 显式指定 openssl 后端：本机实测 git 默认的 schannel 在受限环境下会报
# `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` 而连不上 GitHub。
& $git -C $Root -c http.sslBackend=openssl push "https://$token@github.com/$full.git" "$branch`:refs/heads/$branch" --set-upstream 2>&1 |
  ForEach-Object { $_ -replace [regex]::Escape($token), '***' }   # 万一 git 回显了 URL，也替换掉
if ($LASTEXITCODE -ne 0) {
  Bad "推送失败（退出码 $LASTEXITCODE）"
  Say "  若报 schannel / SEC_E_NO_CREDENTIALS：这是 TLS 后端问题，本脚本已改用 openssl；"
  Say "  若仍失败，可手工执行：git config --local http.sslBackend openssl 后重试。"
  Say "  其他常见原因：token 没有 repo 权限、远端已有内容（需先 pull 或强推）。"
  exit 1
}
Ok "推送完成"

# 确保 origin 是干净地址（万一上面的 --set-upstream 把它改了）
& $git -C $Root remote set-url origin "https://github.com/$full.git"

Say ""
Say "===============================================" Green
Say " 完成：https://github.com/$full" Green
Say "===============================================" Green
Say "  别人安装：打开上面的地址 → Code → Download ZIP → 解压 → 双击 安装.cmd"
Say ""
Say "  提醒：token 仍保存在 $TokenFile，不需要了就删掉它。"
