@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Codex Monitor (含局域网通道)

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node，请先安装 Node.js 22.5 或更高版本。
  pause
  exit /b 1
)

echo ============================================================
echo  正在启动 Codex Monitor（同时监听局域网 / 校园网）
echo.
echo  [!] 本模式会额外监听局域网地址，同一网段内的设备
echo      都能访问这个端口，安全性仅靠密码。
echo      不用的时候请关掉本窗口。
echo ============================================================
echo.

set BIND_LAN=1
node server.mjs

echo.
echo 服务已停止。
pause
