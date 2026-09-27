; Дополнение к установщику Windows (electron-builder, nsis.include).
; Папка models лежит рядом с программой: речь, llama.cpp и языковая модель — несколько гигабайт.
;   обновление — старая версия удаляется, но models остаётся (иначе каждое обновление качало бы всё заново);
;   удаление   — уходит вся папка программы вместе с models.

!macro stopOurLlama
  ; llama-server из нашей папки держит файлы модели — остановить его (чужие llama-server не трогаем)
  nsExec::Exec `powershell.exe -NoProfile -NonInteractive -Command "Get-Process llama-server -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force"`
  Pop $0
!macroend

!macro customRemoveFiles
  !insertmacro stopOurLlama
  SetOutPath $TEMP
  ${if} ${isUpdated}
    FindFirst $R0 $R1 "$INSTDIR\*.*"
    ${DoWhile} $R1 != ""
      ${If} $R1 != "."
      ${AndIf} $R1 != ".."
      ${AndIf} $R1 != "models"
        ${If} ${FileExists} "$INSTDIR\$R1\*.*"
          RMDir /r "$INSTDIR\$R1"
        ${Else}
          Delete "$INSTDIR\$R1"
        ${EndIf}
      ${EndIf}
      FindNext $R0 $R1
    ${Loop}
    FindClose $R0
  ${else}
    RMDir /r $INSTDIR
  ${endif}
!macroend
