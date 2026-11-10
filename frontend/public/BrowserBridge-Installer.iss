#define MyAppName "Little Sunshine Browser Bridge"
#define MyAppVersion "1.2.2"

[Setup]
AppId=LittleSunshineBrowserBridge
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Little Sunshine
DefaultDirName={localappdata}\Programs\Little Sunshine Browser Bridge
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=dist\windows
OutputBaseFilename=BrowserBridge-Windows-Setup-v1.2.2
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\Start-BrowserBridge.cmd

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"

[Files]
Source: "frontend\public\Install-BrowserBridge.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "frontend\public\browser-bridge.zip"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\Start-BrowserBridge.cmd"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\Start-BrowserBridge.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\Install-BrowserBridge.ps1"" -InstallDir ""{app}"" -NoPause"; WorkingDir: "{app}"; StatusMsg: "Installing BrowserBridge dependencies..."; Flags: runhidden waituntilterminated postinstall

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"
Type: files; Name: "{app}\Start-BrowserBridge.ps1"
Type: files; Name: "{app}\Start-BrowserBridge.cmd"

