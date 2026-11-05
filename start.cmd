@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules" (
  echo 首次运行，正在安装依赖...
  call npm install || goto :fail
)
if not exist "dist\index.html" (
  echo 正在构建前端...
  call npm run build || goto :fail
)
echo 启动服务，浏览器打开 http://127.0.0.1:8080
start "" http://127.0.0.1:8080
node server\index.mjs
goto :eof
:fail
echo 启动失败，请检查 Node.js 是否已安装。
pause
