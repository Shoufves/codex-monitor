@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Codex Monitor

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node，请先安装 Node.js 22.5 或更高版本。
  pause
  exit /b 1
)

echo 正在启动 Codex Monitor...
echo 关闭本窗口即可停止服务。
echo.
node server.mjs
echo.
echo 服务已停止。
pause
