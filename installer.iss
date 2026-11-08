#define AppName "CC-Switch Lite"
#define AppExe "CC-Switch-Lite.exe"

[Setup]
AppId=cc-switch-lite.desktop
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\CC-Switch-Lite
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#AppExe}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=release
OutputBaseFilename=CC-Switch-Lite-Setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "node_modules\electron\dist\*"; DestDir: "{app}"; Excludes: "electron.exe,default_app.asar,debug.log"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "node_modules\electron\dist\electron.exe"; DestDir: "{app}"; DestName: "{#AppExe}"; Flags: ignoreversion
Source: "dist-electron\*"; DestDir: "{app}\resources\app\dist-electron"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "package.json"; DestDir: "{app}\resources\app"; Flags: ignoreversion
Source: "node_modules\smol-toml\dist\*"; DestDir: "{app}\resources\app\node_modules\smol-toml\dist"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "node_modules\smol-toml\package.json"; DestDir: "{app}\resources\app\node_modules\smol-toml"; Flags: ignoreversion
Source: "node_modules\smol-toml\LICENSE"; DestDir: "{app}\resources\app\node_modules\smol-toml"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
