; Aevistle installer customisation.
;
; One thing electron-builder does not do on its own: ask, at uninstall time,
; whether to keep the user's data. Schedules, contacts, templates and
; attachment copies are not the program — someone reinstalling or moving
; machines almost never wants them gone, and someone leaving for good
; definitely does. Guessing either way is wrong, so it is a question, and
; "keep" is the default because that is the answer that is still recoverable.
;
; Keeping the program in a folder named Aevistle is NOT done here, because
; electron-builder already does it — see its assistedInstaller.nsh:
;
;     ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
;     ${If} $0 == ""
;       StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
;     ${endIf}
;
; attached as MUI_PAGE_CUSTOMFUNCTION_PRE on the instfiles page. That hook is
; load-bearing: a `.onVerifyInstDir` here that assigns $INSTDIR compiles, runs,
; and does nothing at all — NSIS re-reads the directory page's text field when
; the page is left, discarding the assignment. This file used to contain
; exactly that, and it was verified only through `/D=`, which bypasses the
; directory page entirely and so could never have caught it. Measured: typing
; "D:\APPS\Foo" installs to "D:\APPS\Foo\Aevistle"; typing a path that already
; contains the product name is left as the user wrote it.

!include "LogicLib.nsh"

; The Electron userData folder: %APPDATA%\<package.json "name">. Hard-coded
; rather than derived, because the uninstaller has to find it with no app to
; ask, and this string is ours to keep in step with package.json.
!define AEVISTLE_USERDATA "$APPDATA\aevistle"

; Written by the app next to location.json. One line, one absolute path,
; naming the folder the data actually lives in. A plain file because the
; uninstaller has no JSON parser and a half-parsed path is worse than none.
!define AEVISTLE_PATH_FILE "${AEVISTLE_USERDATA}\datapath.txt"

; ---------------------------------------------------------------------------
; Install — the Send To entry
; ---------------------------------------------------------------------------

; "Right-click a file → Send to → Aevistle."
;
; This is as close as a Win32 application gets to Android's share sheet. The
; real Windows Share charm (the one the Photos app offers) is only available to
; MSIX-packaged apps that declare a ShareTarget extension; an NSIS-installed
; .exe cannot appear there at any price, and pretending otherwise would mean
; shipping a second, sandboxed packaging of the whole app. Send To is the
; mechanism Windows actually gives us: a shortcut in a magic folder, which
; Explorer offers on every file's context menu and invokes with the selected
; paths as command-line arguments. `electron/main.ts` parses them.
;
; SENDTO is per-user by definition — there is no all-users Send To menu that
; modern Windows reads — so the shell context is forced to `current` for the
; one line that needs it and put back afterwards. Leaving it switched would
; silently redirect every $APPDATA and $SMPROGRAMS the rest of the install
; touches, and `perMachine: false` means the two are normally the same anyway;
; this is insurance against that changing.
;
; customInstall runs at the end of the install section, after the Start menu
; and desktop links — see app-builder-lib/templates/nsis/installSection.nsh.
!macro customInstall
  SetShellVarContext current
  CreateShortcut "$SENDTO\${PRODUCT_FILENAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}

  ; -------------------------------------------------------------------------
  ; mailto: — the URL protocol handler, and the Default Apps entry
  ; -------------------------------------------------------------------------
  ;
  ; This is written by hand because electron-builder will not write it. Its
  ; `protocols:` option looks like it covers Windows and does not: only
  ; electronMac.js, LinuxTargetHelper.js and AppxTarget.js read that key —
  ; NsisTarget.js never does (checked against app-builder-lib 26.15.3). Setting
  ; it and assuming produces an installer that builds cleanly and registers
  ; nothing, which is the exact failure this project keeps writing gates for.
  ;
  ; `app.setAsDefaultProtocolClient('mailto')` in electron/main.ts writes the
  ; first half of this at runtime, so why both? Because that call only creates
  ; HKCU\Software\Classes\mailto — the fallback Windows consults when nothing
  ; else claims the scheme. It does not put Aevistle in the list Settings →
  ; Default apps offers, so on any machine that already has a mail client (or
  ; that has ever been asked the question) there is no way for the user to
  ; choose this one. The Capabilities block below is what puts it on that list.
  ;
  ; SHELL_CONTEXT is HKCU here, because perMachine is false. The keys mirror
  ; what a per-user install is allowed to write; nothing goes to HKLM and
  ; nothing touches UserChoice, which is hash-protected and not ours to set.
  ; Windows still asks the user before switching.
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PRODUCT_FILENAME}.Url.mailto" "" "Aevistle mail link"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PRODUCT_FILENAME}.Url.mailto" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PRODUCT_FILENAME}.Url.mailto\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PRODUCT_FILENAME}.Url.mailto\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; The Default Apps registration. `ApplicationName` is a proper noun and so is
  ; not translated; no other user-facing string is introduced here.
  WriteRegStr SHELL_CONTEXT "Software\Clients\Mail\${PRODUCT_FILENAME}" "" "${PRODUCT_FILENAME}"
  WriteRegStr SHELL_CONTEXT "Software\Clients\Mail\${PRODUCT_FILENAME}\Capabilities" "ApplicationName" "${PRODUCT_FILENAME}"
  WriteRegStr SHELL_CONTEXT "Software\Clients\Mail\${PRODUCT_FILENAME}\Capabilities\UrlAssociations" "mailto" "${PRODUCT_FILENAME}.Url.mailto"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_FILENAME}" "Software\Clients\Mail\${PRODUCT_FILENAME}\Capabilities"
!macroend

; ---------------------------------------------------------------------------
; Uninstall — keep the data, or remove it
; ---------------------------------------------------------------------------

; The one question this installer asks in its own words, so it is also the one
; that has to be translated. The rest of the wizard is localised by NSIS from
; $LANGUAGE; a lone English message box in an otherwise Chinese wizard is the
; kind of seam that makes an application feel assembled rather than built.
;
; Written as a macro rather than a LangString table because customUnInstall is
; expanded inside the uninstaller, where installer-side LangStrings are not in
; scope. $LANGUAGE holds the LANGID chosen at install time.
!macro aevistleDataPrompt OUT
  ${If} $LANGUAGE == 2052
    StrCpy ${OUT} "要同时删除 Aevistle 的数据吗？$\r$\n$\r$\n\
这会删除你的定时任务、联系人、模板、发送记录、已保存的密码和附件副本。$\r$\n$\r$\n\
选择「否」则只卸载程序，数据保留给下次安装使用。"
  ${ElseIf} $LANGUAGE == 1036
    StrCpy ${OUT} "Supprimer également vos données Aevistle ?$\r$\n$\r$\n\
Cela efface vos planifications, contacts, modèles, journal d'activité, mots de passe enregistrés et copies de pièces jointes.$\r$\n$\r$\n\
Choisissez Non pour ne retirer que le programme et conserver vos données."
  ${ElseIf} $LANGUAGE == 1034
  ${OrIf} $LANGUAGE == 3082
    StrCpy ${OUT} "¿Eliminar también tus datos de Aevistle?$\r$\n$\r$\n\
Esto borra tus programaciones, contactos, plantillas, registro de actividad, contraseñas guardadas y copias de adjuntos.$\r$\n$\r$\n\
Elige No para quitar solo el programa y conservar tus datos."
  ${ElseIf} $LANGUAGE == 1049
    StrCpy ${OUT} "Удалить также данные Aevistle?$\r$\n$\r$\n\
Будут удалены расписания, контакты, шаблоны, журнал отправок, сохранённые пароли и копии вложений.$\r$\n$\r$\n\
Выберите «Нет», чтобы удалить только программу и сохранить данные."
  ${ElseIf} $LANGUAGE == 1025
    StrCpy ${OUT} "هل تريد حذف بيانات Aevistle أيضًا؟$\r$\n$\r$\n\
سيؤدي هذا إلى حذف جداولك وجهات اتصالك وقوالبك وسجل الإرسال وكلمات المرور المحفوظة ونسخ المرفقات.$\r$\n$\r$\n\
اختر «لا» لإزالة البرنامج فقط والاحتفاظ ببياناتك."
  ${Else}
    StrCpy ${OUT} "Remove your Aevistle data as well?$\r$\n$\r$\n\
This deletes your schedules, contacts, templates, activity log, saved passwords and attachment copies.$\r$\n$\r$\n\
Choose No to remove only the program and keep your data for a future install."
  ${EndIf}
!macroend

!macro customUnInstall
  ; $R5 records which way this went, and is written to a log at the end. The
  ; first version of this macro deleted the data twice in testing without ever
  ; showing its dialog, and there was no way to tell from the outside whether
  ; the prompt had been answered, skipped, or never reached.
  StrCpy $R5 "skipped(isUpdated)"

  ${ifNot} ${isUpdated}
    ; An update reinstalls over the top and must never ask, let alone delete.
    StrCpy $R5 "keep"
    !insertmacro aevistleDataPrompt $R4

    ; Keeping is the fall-through, deleting needs an explicit jump.
    ;
    ; The previous shape put the delete block immediately after the MessageBox
    ; and relied on `IDNO` jumping over it. Anything that makes the message box
    ; not return IDYES — a suppressed dialog, a silent parent process, a
    ; mis-parsed return check — then lands *in* the deletion path. A branch that
    ; erases someone's saved passwords must be unreachable except by them
    ; saying yes, so now the only way in is the IDYES jump, and the instruction
    ; after the box is an unconditional jump straight past it.
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$R4" /SD IDNO IDYES AevistleDeleteData
    Goto AevistleDataDone

    AevistleDeleteData:
      StrCpy $R5 "delete"
      ; The data may have been moved elsewhere. Read that location first —
      ; removing the default folder is what destroys the note saying where it
      ; went.
      ClearErrors
      FileOpen $R1 "${AEVISTLE_PATH_FILE}" r
      ${IfNot} ${Errors}
        FileRead $R1 $R2
        FileClose $R1

        ; Trim the trailing newline by hand. FileFunc's ${TrimNewLines} exists
        ; only as ${un.TrimNewLines} inside an uninstaller, and reaching for the
        ; installer-side name is what made this script fail to compile.
        AevistleTrim:
          StrCpy $R3 "$R2" 1 -1
          ${If} $R3 == "$\r"
          ${OrIf} $R3 == "$\n"
            StrCpy $R2 "$R2" -1
            Goto AevistleTrim
          ${EndIf}

        ${If} $R2 != ""
        ${AndIf} $R2 != "${AEVISTLE_USERDATA}"
          RMDir /r "$R2"
        ${EndIf}
      ${EndIf}
      RMDir /r "${AEVISTLE_USERDATA}"

    AevistleDataDone:
  ${endIf}

  ; One line, overwritten each run. Cheap, and it is the difference between
  ; "the data is gone" and "the data is gone *because*".
  ;
  ; ${Silent} is a LogicLib condition, not a variable — interpolating it into a
  ; string is a compile error, and that error was invisible for three rebuilds
  ; because a leftover setup.exe process held the output file open, so
  ; electron-builder failed to overwrite it and the previous artifact sat there
  ; looking like a successful build.
  StrCpy $R7 "no"
  ${If} ${Silent}
    StrCpy $R7 "yes"
  ${EndIf}

  ClearErrors
  FileOpen $R6 "$TEMP\aevistle-uninstall.log" w
  ${IfNot} ${Errors}
    FileWrite $R6 "silent=$R7 lang=$LANGUAGE branch=$R5$\r$\n"
    FileClose $R6
  ${EndIf}

  ; The Send To entry goes with the program, never with the data — it is a
  ; shortcut to an executable that is about to be deleted.
  ;
  ; Removed on an update as well as a real uninstall. customInstall recreates
  ; it moments later, and a shortcut left pointing at the old install directory
  ; is worse than no shortcut: it stays on the context menu and does nothing.
  ;
  ; Last in the macro, and the context is restored, because everything above
  ; reads $APPDATA — which resolves to ProgramData under the `all` context and
  ; would look for the user's data in a folder that has never held any.
  SetShellVarContext current
  Delete "$SENDTO\${PRODUCT_FILENAME}.lnk"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}

  ; The mailto registration, in the reverse order it was written. Left behind,
  ; these would keep Aevistle in Settings → Default apps pointing at an
  ; executable that no longer exists — and a mailto link would then open
  ; nothing at all, with no way for the user to see why.
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_FILENAME}"
  DeleteRegKey SHELL_CONTEXT "Software\Clients\Mail\${PRODUCT_FILENAME}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${PRODUCT_FILENAME}.Url.mailto"
!macroend
