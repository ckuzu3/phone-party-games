@echo off
title Wii-Style Sports - server
cd /d "%~dp0"

rem Prefer "python", fall back to the "py" launcher.
where python >nul 2>nul
if %errorlevel%==0 (set PY=python) else (set PY=py)

rem Open the game screen once the server has had a moment to start.
start "" /min cmd /c "timeout /t 3 >nul & start """" http://localhost:8080/"

%PY% -u server.py

echo.
echo The server has stopped.
pause
