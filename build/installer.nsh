# Unlucky: поведение установщика при повторном запуске
#
#   • не установлен                  → обычная установка;
#   • установлена более старая версия → предлагаем обновиться (настройки, скины и игры сохраняются);
#   • установлена та же версия        → предлагаем удалить лаунчер вместе со всеми его файлами;
#   • установлена более новая версия  → предупреждаем, что это понижение версии.
#
# В тихом режиме (установщик запущен с ключом /S) вопросов нет: лаунчер просто ставится или обновляется поверх.
# Файл должен быть в кодировке UTF-8 с BOM — иначе русский текст в установщике превратится в кракозябры.

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !include "WordFunc.nsh"
    !insertmacro VersionCompare
  !endif
!macroend

# Кладёт в переменную VAR русский или английский текст — по языку установщика (он выбирается по языку Windows).
!macro unlText VAR RU EN
  ${If} $LANGUAGE == 1049
    StrCpy ${VAR} "${RU}"
  ${Else}
    StrCpy ${VAR} "${EN}"
  ${EndIf}
!macroend

# ------------------------------------------------------------------ установщик
!macro customInit
  ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ReadRegStr $R1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"

  # Первая установка: папка «Unlucky» вместо имени пакета «unlucky-launcher» (явный ключ /D=... не трогаем).
  ${If} $R1 == ""
    StrLen $R5 "\${APP_FILENAME}"
    StrCpy $R6 $INSTDIR "" -$R5
    ${If} $R6 == "\${APP_FILENAME}"
      StrCpy $R7 $INSTDIR -$R5
      StrCpy $INSTDIR "$R7\${PRODUCT_FILENAME}"
    ${EndIf}
  ${EndIf}

  ${IfNot} ${Silent}
    ${If} $R0 != ""
    ${AndIf} $R1 != ""
    ${AndIf} ${FileExists} "$R1\${UNINSTALL_FILENAME}"
      # $R2: 1 — этот установщик новее установленной версии, 0 — версии равны, 2 — установленная версия новее
      ${VersionCompare} "${VERSION}" "$R0" $R2

      ${If} $R2 == 1
        !insertmacro unlText $R4 "Установлена версия $R0.$\r$\nОбновить Unlucky до версии ${VERSION}?$\r$\n$\r$\nНастройки, скины и скачанные версии игры сохранятся." "Version $R0 is installed.$\r$\nUpdate Unlucky to version ${VERSION}?$\r$\n$\r$\nYour settings, skins and downloaded game versions will be kept."
        MessageBox MB_YESNO|MB_ICONQUESTION "$R4" IDYES +2
        Quit

      ${ElseIf} $R2 == 0
        !insertmacro unlText $R4 "Unlucky ${VERSION} уже установлен.$\r$\n$\r$\nУдалить лаунчер и ВСЕ его файлы?$\r$\n$\r$\nБудут удалены: программа, настройки, скины, скачанные версии игры и Java, миры и скриншоты." "Unlucky ${VERSION} is already installed.$\r$\n$\r$\nRemove the launcher and ALL of its files?$\r$\n$\r$\nThis deletes the program, settings, skins, downloaded game versions and Java, worlds and screenshots."
        MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$R4" IDYES +2
        Quit

        # Запускаем копию деинсталлятора из временной папки и ждём её: так удалится и сама папка установки.
        InitPluginsDir
        CopyFiles /SILENT "$R1\${UNINSTALL_FILENAME}" "$PLUGINSDIR\unlucky-uninstall.exe"
        ClearErrors
        ExecWait '"$PLUGINSDIR\unlucky-uninstall.exe" /S /currentuser --delete-app-data _?=$R1' $R3
        ${If} ${Errors}
        ${OrIf} $R3 != 0
          !insertmacro unlText $R4 "Не удалось удалить Unlucky (код $R3). Закройте лаунчер и игру и попробуйте ещё раз." "Could not remove Unlucky (code $R3). Close the launcher and the game and try again."
          MessageBox MB_OK|MB_ICONSTOP "$R4"
          SetErrorLevel 2
        ${Else}
          !insertmacro unlText $R4 "Unlucky удалён вместе со всеми файлами." "Unlucky and all of its files have been removed."
          MessageBox MB_OK|MB_ICONINFORMATION "$R4"
        ${EndIf}
        Quit

      ${Else}
        !insertmacro unlText $R4 "Установлена более новая версия: $R0.$\r$\nЭтот установщик — версия ${VERSION}.$\r$\n$\r$\nВсё равно поставить старую версию поверх?" "A newer version is installed: $R0.$\r$\nThis installer is version ${VERSION}.$\r$\n$\r$\nInstall the older version over it anyway?"
        MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$R4" IDYES +2
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

# ------------------------------------------------------------------ деинсталлятор
# Если лаунчер удаляют вручную («Установка и удаление программ» или Uninstall Unlucky.exe), спрашиваем про данные.
# Обновление (--updated), тихий режим (/S) и явное --delete-app-data вопросов не задают — их обрабатывает сам electron-builder.
!macro customInstall
  # electron-builder кладёт сюда копию самого установщика (~100 МБ) для дифференциального автообновления.
  # Автообновления у Unlucky нет, поэтому лишнюю копию сразу убираем.
  !ifdef APP_INSTALLER_STORE_FILE
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    ${StdUtils.GetParentPath} $R5 "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    RMDir "$R5"
  !endif
!macroend

!macro customUnInstall
  # Хвост от старых установок: копия установщика в LocalAppData.
  !ifdef APP_INSTALLER_STORE_FILE
    !ifdef APP_PACKAGE_NAME
      Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
      RMDir "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
    !endif
  !endif

  ${GetParameters} $R0
  ${GetOptions} $R0 "--updated" $R1
  ${If} ${Errors}
    ClearErrors
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${If} ${Errors}
      ClearErrors
      ${GetOptions} $R0 "/S" $R1
      ${If} ${Errors}
        ClearErrors
        !insertmacro unlText $R4 "Удалить также данные Unlucky?$\r$\n$\r$\nНастройки, скины, скачанные версии игры и Java, миры и скриншоты." "Also delete Unlucky data?$\r$\n$\r$\nSettings, skins, downloaded game versions and Java, worlds and screenshots."
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$R4" IDYES unl_wipe IDNO unl_keep
        unl_wipe:
          RMDir /r "$APPDATA\${APP_FILENAME}"
          !ifdef APP_PRODUCT_FILENAME
            RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
          !endif
          !ifdef APP_PACKAGE_NAME
            RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
          !endif
        unl_keep:
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend
