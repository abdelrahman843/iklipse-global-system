; iklipse for Windows: installs for this person only (no admin), starts with
; Windows in the tray, and runs quietly for updates (/VERYSILENT), opening
; iklipse again when it's done. Built by .github/workflows/desktop.yml.

#define AppVersion GetEnv("APP_VERSION")

[Setup]
AppId={{8A5C2E4F-3B1D-4E7A-9C62-1F0D5B7E3A91}
AppName=iklipse
AppVersion={#AppVersion}
AppVerName=iklipse {#AppVersion}
AppPublisher=iklipse
DefaultDirName={localappdata}\Programs\iklipse
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=out
OutputBaseFilename=iklipse-setup
SetupIconFile=iklipse.ico
UninstallDisplayIcon={app}\iklipse.exe
UninstallDisplayName=iklipse
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "Add iklipse to the desktop"

[Files]
Source: "bin\Release\net48\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\iklipse"; Filename: "{app}\iklipse.exe"
Name: "{userdesktop}\iklipse"; Filename: "{app}\iklipse.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "iklipse"; ValueData: """{app}\iklipse.exe"" --hidden"; Flags: uninsdeletevalue
; iklipse:// links open the app: the way back after connecting an account in the browser (public/back.html).
Root: HKCU; Subkey: "Software\Classes\iklipse"; ValueType: string; ValueName: ""; ValueData: "URL:iklipse"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\iklipse"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\iklipse\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\iklipse.exe"",0"
Root: HKCU; Subkey: "Software\Classes\iklipse\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\iklipse.exe"" ""%1"""

[Run]
; Also after a quiet update.
Filename: "{app}\iklipse.exe"; Description: "Open iklipse"; Flags: nowait postinstall

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/im iklipse.exe /f"; Flags: runhidden; RunOnceId: "StopIklipse"
