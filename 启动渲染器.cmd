@echo off
setlocal
cd /d "%~dp0"
set "PORT=8099"
if not "%PHICHART_PORT%"=="" set "PORT=%PHICHART_PORT%"
rem 绑定地址：默认 0.0.0.0（同一局域网的其他设备也能打开）；只给本机用就设 PHICHART_HOST=127.0.0.1
set "HOST=0.0.0.0"
if not "%PHICHART_HOST%"=="" set "HOST=%PHICHART_HOST%"

rem ---- locate a working Python 3 (label based flow: no parenthesised blocks) ----
set "PY="
where python >nul 2>nul
if errorlevel 1 goto TRY_PY
python -c "import sys" >nul 2>nul
if errorlevel 1 goto TRY_PY
set "PY=python"
goto HAVE_PY

:TRY_PY
where py >nul 2>nul
if errorlevel 1 goto NO_PY
py -3 -c "import sys" >nul 2>nul
if errorlevel 1 goto NO_PY
set "PY=py -3"
goto HAVE_PY

:NO_PY
echo [ERROR] Python 3 was not found on PATH.
echo   Option A: install Python 3 from https://www.python.org/downloads/
echo   Option B: install Node.js then run this line in the project root:
echo       npx --yes serve -l %PORT% .
echo   Then open the start page at http://127.0.0.1:%PORT%/start.html
pause
exit /b 1

:HAVE_PY
echo Project  : %CD%
echo Server   : %PY% tools\dev_server.py --host %HOST% --port %PORT%   (no-store: 防止新旧脚本混搭)
echo Start    : http://127.0.0.1:%PORT%/start.html   (open project / package / new project)
echo Player   : http://127.0.0.1:%PORT%/index.html
echo Editor   : http://127.0.0.1:%PORT%/edit.html
if "%HOST%"=="0.0.0.0" echo LAN      : 局域网其他设备可用 http://本机IP:%PORT%/edit.html  （下面会列出具体地址）
if not "%HOST%"=="0.0.0.0" echo LAN      : 仅本机（要对局域网开放：set PHICHART_HOST=0.0.0.0）
echo Stop     : Ctrl+C in this window
echo.
if "%PHICHART_NO_BROWSER%"=="1" goto RUN
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/start.html'"

:RUN
rem 用自带服务器（显式 no-store，默认监听全部网卡）：python -m http.server 不发缓存头，会让浏览器缓存住旧模块
if not exist "tools\dev_server.py" goto RUN_PLAIN
%PY% tools\dev_server.py --host %HOST% --port %PORT%
goto DONE

:RUN_PLAIN
echo [WARN] tools\dev_server.py not found - falling back to python -m http.server (缓存可能导致脚本混搭)
if "%HOST%"=="0.0.0.0" goto RUN_PLAIN_ALL
%PY% -m http.server %PORT% --bind %HOST%
goto DONE

:RUN_PLAIN_ALL
%PY% -m http.server %PORT% --bind 0.0.0.0

:DONE
endlocal
