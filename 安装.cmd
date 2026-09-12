@echo off
rem ============================================================
rem  自选股看板 - 一键安装
rem  双击本文件即可。它只是用正确的权限调用 install.ps1，
rem  因为 Windows 默认不允许直接双击运行 .ps1。
rem  本文件刻意只用 ASCII 字符：cmd.exe 按系统代码页读取批处理，
rem  写入非 ASCII 会因编码不一致而解析失败。
rem ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
echo Press any key to close...
pause >nul
