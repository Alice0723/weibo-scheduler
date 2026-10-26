# 微博日程 · 本地试跑（PowerShell 一键版）
#
# 用法：
#   1. 把浏览器复制的微博 Cookie 存成同目录下的 cookie.txt
#   2. 右键这个文件 →「使用 PowerShell 运行」
#   或者在 PowerShell 里执行：  .\try-local.ps1
#
# 这个脚本存在的意义：绕开 PowerShell 的两个坑
#   · 中文乱码：PowerShell 5.1 用 GBK 解码子进程输出 → 这里强制切 UTF-8
#   · 环境变量语法：PowerShell 里 `FOO=bar node x.js` 不生效 → 这里统一用 cookie.txt

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# 强制 UTF-8，解决中文乱码
try { chcp 65001 > $null } catch {}
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

Write-Host ""
Write-Host "  微博日程 · 本地试跑" -ForegroundColor Cyan
Write-Host "  ================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "cookie.txt")) {
  Write-Host "  没有找到 cookie.txt" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  请先创建这个文件，把微博 Cookie 粘进去：" -ForegroundColor Yellow
  Write-Host "    $($PSScriptRoot)\cookie.txt"
  Write-Host ""
  Write-Host "  Cookie 怎么拿：" -ForegroundColor Yellow
  Write-Host "    1. 浏览器登录微博（小号也行）"
  Write-Host "    2. 打开 https://m.weibo.cn/u/5523180767"
  Write-Host "    3. F12 -> Network -> 点任意请求 -> Request Headers -> 复制 Cookie 整行"
  Write-Host ""
  Write-Host "  必须包含 SUB= 这一段，否则微博一律返回 432。" -ForegroundColor Red
  Write-Host ""
  Read-Host "  按回车键退出"
  exit 1
}

Write-Host "  找到 cookie.txt，开始抓取..." -ForegroundColor Green
Write-Host ""

node scripts/try-local.js
$code = $LASTEXITCODE

Write-Host ""
if ($code -eq 0) {
  Write-Host "  试跑成功" -ForegroundColor Green
  Write-Host "  下一步：建 GitHub 仓库 -> 配 WEIBO_COOKIE Secret -> 触发 Actions" -ForegroundColor Green
} else {
  Write-Host "  试跑失败（退出码 $code），看上面的提示排查" -ForegroundColor Yellow
}
Write-Host ""
Read-Host "  按回车键退出"
exit $code
