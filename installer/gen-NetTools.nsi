Unicode true
RequestExecutionLevel admin
ManifestSupportedOS all
SetCompressor zlib
CRCCheck on
Name "gen-NetTools"
OutFile "${OUTPUT}"
InstallDir "$PROGRAMFILES64\gen-NetTools"
ShowInstDetails show
ShowUninstDetails show

!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\gen-NetTools"
!ifndef VERSION_NUMERIC
  !define VERSION_NUMERIC "${VERSION}.0"
!endif
VIProductVersion "${VERSION_NUMERIC}"
VIAddVersionKey /LANG=2052 "ProductName" "gen-NetTools"
VIAddVersionKey /LANG=2052 "FileDescription" "gen-NetTools Windows x64 离线安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"

Var DataDir
Var LockHandle
Var PurgeData
Var Existing

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "退出安装并启动程序"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchInstalledApp
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

!macro GuardPath PATH
  System::Call 'kernel32::GetFileAttributesW(w "${PATH}") i.r0'
  ${If} $0 != -1
    IntOp $0 $0 & 0x400
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "此路径包含链接或重解析点，请先检查 gen-NetTools 目录。" /SD IDOK
      SetErrorLevel 5
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro AcquireLock
  !insertmacro GuardPath "$DataDir"
  !insertmacro GuardPath "$DataDir\instance.lock"
  System::Call 'kernel32::CreateFileW(w "$DataDir\instance.lock", i 0xC0000000, i 0, p 0, i 4, i 0x80, p 0) p.r0'
  ${If} $0 == -1
    MessageBox MB_OK|MB_ICONSTOP "无法锁定共享数据。请先退出其他 Windows 会话中的 gen-NetTools，再重试。" /SD IDOK
    SetErrorLevel 5
    Abort
  ${EndIf}
  StrCpy $LockHandle $0
!macroend

!macro CloseLock
  ${If} $LockHandle != ""
    System::Call 'kernel32::CloseHandle(p $LockHandle)'
    StrCpy $LockHandle ""
  ${EndIf}
!macroend

!macro ExtractHelper
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=machine-helper.exe "${STAGE}\resources\app\dist\machine-helper.exe"
!macroend

!macro PurgeApp FOLDER
  nsExec::ExecToStack '"$PLUGINSDIR\machine-helper.exe" purge-app "${FOLDER}"'
  Pop $0
  Pop $1
!macroend

Function LaunchInstalledApp
  nsExec::ExecToStack /TIMEOUT=10000 '"$PLUGINSDIR\machine-helper.exe" launch-installed'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONINFORMATION "安装已完成。请从 Windows 开始菜单打开 gen-NetTools。"
  ${EndIf}
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "gen-NetTools 需要 64 位 Windows。" /SD IDOK
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "gen-NetTools 需要 Windows 10 或更新版本。" /SD IDOK
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
  StrCpy $DataDir "$APPDATA\gen-NetTools"
  ReadRegStr $Existing HKLM "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $Existing != ""
    StrCpy $INSTDIR $Existing
  ${EndIf}
FunctionEnd

Function .onVerifyInstDir
  ${GetRoot} "$INSTDIR" $0
  ${If} $0 == ""
  ${OrIf} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
  ${OrIf} $INSTDIR == "$DataDir"
    Abort
  ${EndIf}
  ${If} $Existing != ""
  ${AndIf} $INSTDIR != $Existing
    Abort
  ${EndIf}
FunctionEnd

Section "安装 gen-NetTools"
  Call .onVerifyInstDir
  !insertmacro GuardPath "$INSTDIR"
  !insertmacro GuardPath "$INSTDIR\app"
  !insertmacro GuardPath "$DataDir"
  IfFileExists "$INSTDIR\gen-NetTools.install" owned
  IfFileExists "$INSTDIR\app\*.*" collision
  IfFileExists "$INSTDIR\app.pending\*.*" collision
  IfFileExists "$INSTDIR\app.previous\*.*" collision
  IfFileExists "$INSTDIR\Uninstall.exe" collision
  Goto fresh
  collision:
    MessageBox MB_OK|MB_ICONSTOP "安装目录中的程序文件与 gen-NetTools 冲突。请选择专用目录。" /SD IDOK
    SetErrorLevel 5
    Abort
  fresh:
    CreateDirectory "$INSTDIR"
    ClearErrors
    FileOpen $0 "$INSTDIR\gen-NetTools.install" w
    IfErrors install_failed
    FileWrite $0 "gen-NetTools"
    FileClose $0
  owned:
  ClearErrors
  CreateDirectory "$DataDir"
  IfErrors install_failed
  ; Built-in Users can use the same SQLite workspace. The directory itself keeps its owner and existing administrative access.
  nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$DataDir" /grant "*S-1-5-32-545:(RX,WD,AD,REA,WEA)" "*S-1-5-32-545:(OI)(CI)(IO)M" /Q'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "无法设置共享数据目录权限。" /SD IDOK
    SetErrorLevel 5
    Abort
  ${EndIf}
  !insertmacro AcquireLock
  !insertmacro ExtractHelper

  ; A retained previous version is only removable after a current version exists.
  IfFileExists "$INSTDIR\app.previous\*.*" 0 prepare
  IfFileExists "$INSTDIR\app\gen-NetTools.exe" 0 recover_previous
  !insertmacro PurgeApp "$INSTDIR\app.previous"
  ${If} $0 != 0
    Goto install_failed
  ${EndIf}
  Goto prepare
  recover_previous:
    ClearErrors
    Rename "$INSTDIR\app.previous" "$INSTDIR\app"
    IfErrors install_failed
  prepare:
  !insertmacro PurgeApp "$INSTDIR\app.pending"
  ${If} $0 != 0
    Goto install_failed
  ${EndIf}
  ClearErrors
  SetOutPath "$INSTDIR\app.pending"
  File /r "${STAGE}\*.*"
  IfErrors bad_extraction
  IfFileExists "$INSTDIR\app.pending\resources\app\dist\huawei-seed.json" 0 bad_extraction
  IfFileExists "$INSTDIR\app.pending\gen-NetTools.exe" 0 bad_extraction
  SetOutPath "$INSTDIR"
  IfFileExists "$INSTDIR\app\*.*" 0 activate
  ClearErrors
  Rename "$INSTDIR\app" "$INSTDIR\app.previous"
  IfErrors bad_extraction
  activate:
  ClearErrors
  Rename "$INSTDIR\app.pending" "$INSTDIR\app"
  IfErrors rollback
  ClearErrors
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  IfErrors rollback_active
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "gen-NetTools"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\app\gen-NetTools.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
  CreateShortCut "$SMPROGRAMS\gen-NetTools.lnk" "$INSTDIR\app\gen-NetTools.exe"
  !insertmacro PurgeApp "$INSTDIR\app.previous"
  ${If} $0 != 0
    DetailPrint "旧程序文件暂时保留，可在下次安装时清理。"
  ${EndIf}
  !insertmacro CloseLock
  Goto install_done

  rollback_active:
    !insertmacro PurgeApp "$INSTDIR\app"
  rollback:
    IfFileExists "$INSTDIR\app.previous\*.*" 0 bad_extraction
    Rename "$INSTDIR\app.previous" "$INSTDIR\app"
  bad_extraction:
    SetOutPath "$INSTDIR"
    !insertmacro PurgeApp "$INSTDIR\app.pending"
  install_failed:
    !insertmacro CloseLock
    SetErrorLevel 5
    MessageBox MB_OK|MB_ICONSTOP "安装失败。请检查目录、权限和磁盘空间后重试。" /SD IDOK
    Abort
  install_done:
SectionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext all
  StrCpy $DataDir "$APPDATA\gen-NetTools"
  StrCpy $PurgeData "0"
  ${If} ${Silent}
    ${GetParameters} $0
    ClearErrors
    ${GetOptions} $0 "/DELETE_DATA" $1
    ${IfNot} ${Errors}
    ${AndIf} $1 == ""
      StrCpy $PurgeData "1"
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "un.卸载 gen-NetTools"
  !insertmacro GuardPath "$INSTDIR"
  IfFileExists "$INSTDIR\gen-NetTools.install" 0 uninstall_failed
  CreateDirectory "$DataDir"
  !insertmacro AcquireLock
  !insertmacro ExtractHelper
  ${IfNot} ${Silent}
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION|MB_DEFBUTTON2 "是否删除本机共享的字段库、模型设置和分析历史？$\r$\n$\r$\n是：删除应用数据。$\r$\n否：保留应用数据。$\r$\n取消：退出卸载。" IDYES delete_data IDNO keep_data
    !insertmacro CloseLock
    SetErrorLevel 1
    Abort
    delete_data:
    StrCpy $PurgeData "1"
    keep_data:
  ${EndIf}

  !insertmacro PurgeApp "$INSTDIR\app.pending"
  ${If} $0 != 0
    Goto uninstall_failed
  ${EndIf}
  !insertmacro PurgeApp "$INSTDIR\app.previous"
  ${If} $0 != 0
    Goto uninstall_failed
  ${EndIf}
  !insertmacro PurgeApp "$INSTDIR\app"
  ${If} $0 != 0
    Goto uninstall_failed
  ${EndIf}
  ${If} $PurgeData == "1"
    nsExec::ExecToStack '"$PLUGINSDIR\machine-helper.exe" purge-data'
    Pop $2
    Pop $1
    !insertmacro CloseLock
    Delete "$DataDir\instance.lock"
    RMDir "$DataDir"
    ${If} $2 != 0
      DetailPrint "部分共享文件无法删除，已保留以供检查。"
      SetErrorLevel 4
    ${EndIf}
  ${Else}
    !insertmacro CloseLock
  ${EndIf}
  Delete "$SMPROGRAMS\gen-NetTools.lnk"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  Delete "$INSTDIR\gen-NetTools.install"
  Delete /REBOOTOK "$INSTDIR\Uninstall.exe"
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
  Goto uninstall_done

  uninstall_failed:
    !insertmacro CloseLock
    SetErrorLevel 5
    MessageBox MB_OK|MB_ICONSTOP "卸载未完成。请确认应用已经退出并检查安装目录。" /SD IDOK
    Abort
  uninstall_done:
SectionEnd
