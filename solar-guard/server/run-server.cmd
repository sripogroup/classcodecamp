@echo off
rem ---------------------------------------------------------------------------
rem  Launcher for the Solar Guard local server, used by Task Scheduler.
rem
rem  ASCII only, deliberately. cmd.exe reads .cmd files using the OEM codepage,
rem  so UTF-8 Thai text in comments is decoded as garbage bytes and the parser
rem  then treats fragments of it as commands. Same trap as the .ps1 files.
rem
rem  This wrapper exists because putting the whole command inline in the task
rem  needs three nested levels of quoting (cmd, paths with spaces, redirection)
rem  and breaks in ways that are painful to debug from a scheduled task.
rem
rem  chcp 65001 must come first, otherwise the redirected log is written in the
rem  OEM codepage and every Thai character in it turns into mojibake - unreadable
rem  exactly when someone needs to read it.
rem ---------------------------------------------------------------------------

chcp 65001 >nul
cd /d "%~dp0.."

set "LOGFILE=%USERPROFILE%\solar-guard-server.log"

set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" for /f "delims=" %%i in ('where node 2^>nul') do set "NODE=%%i"
if not exist "%NODE%" (
    echo [run-server] node.exe not found >> "%LOGFILE%"
    exit /b 1
)

echo [run-server] start %DATE% %TIME% >> "%LOGFILE%"
"%NODE%" "%~dp0server.js" %* >> "%LOGFILE%" 2>&1
echo [run-server] stopped exit=%ERRORLEVEL% >> "%LOGFILE%"
