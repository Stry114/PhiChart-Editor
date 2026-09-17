@echo off
setlocal
cd /d "%~dp0"
set "PORT=8099"
if not "%PHICHART_PORT%"=="" set "PORT=%PHICHART_PORT%"

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
echo   Then open the renderer at http://127.0.0.1:%PORT%/index.html
pause
exit /b 1

:HAVE_PY
echo Project  : %CD%
echo Server   : %PY% -m http.server %PORT% --bind 127.0.0.1
echo Renderer : http://127.0.0.1:%PORT%/index.html
echo Stop     : Ctrl+C in this window
echo.
if "%PHICHART_NO_BROWSER%"=="1" goto RUN
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/index.html'"

:RUN
%PY% -m http.server %PORT% --bind 127.0.0.1
endlocal
