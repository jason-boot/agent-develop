@echo off
setlocal
set "INSTALL_SCRIPT=%~dp0Install-BrowserBridge.ps1"
if not exist "%INSTALL_SCRIPT%" (
  echo Install-BrowserBridge.ps1 is missing. Extract the complete installer package first.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_SCRIPT%"
