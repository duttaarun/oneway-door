@echo off
rem Recreates the demo's git branches when the project arrives as a zip. A zip has no .git folder (or only main),
rem but the demo needs main and the six demo branches, with their history. demo\branches.bundle carries them.
rem Usage: demo\restore-branches.cmd      from anywhere, any number of times (it never moves an existing branch)
setlocal
chcp 65001 >nul
set "HERE=%~dp0"
set "BUNDLE=%HERE%branches.bundle"
pushd "%HERE%.."

where git >nul 2>nul
if errorlevel 1 (
  echo Restore stopped: git isn't installed or isn't on PATH. Install Git for Windows, then run this again.
  goto :fail
)
if not exist "%BUNDLE%" (
  echo Restore stopped: %BUNDLE% is missing. Copy it from the original project.
  goto :fail
)

set "FRESH=no"
if not exist ".git" (
  echo No git repository here, as a zip has none. Creating one.
  git init -q || goto :fail
  set "FRESH=yes"
) else (
  git rev-parse --verify -q HEAD >nul 2>nul || set "FRESH=yes"
)
if "%FRESH%"=="yes" git symbolic-ref HEAD refs/heads/main || goto :fail
git bundle verify -q "%BUNDLE%" >nul 2>nul
if errorlevel 1 (
  echo Restore stopped: %BUNDLE% is damaged. Copy it again.
  goto :fail
)

if "%FRESH%"=="yes" call :restore_main || goto :fail

echo Branches:
for %%B in (main pr-482-minor-units split/1-expand split/2-migrate split/3-contract split/4-drop) do (
  call :branch %%B || goto :fail
)

echo.
git for-each-ref "--format=  %%(refname:short)  %%(objectname:short)  %%(subject)" refs/heads/
echo.
echo Done. Next: demo\start.cmd
popd
exit /b 0

:restore_main
rem main comes from the bundle, so it keeps its history; the files stay exactly as they came in the zip.
git fetch -q --update-head-ok "%BUNDLE%" refs/heads/main:refs/heads/main || exit /b 1
git reset -q || exit /b 1
git -c core.safecrlf=false add -A || exit /b 1
git diff --cached --quiet && exit /b 0
set "MSG=Restore: the files from the zip, on top of the bundled history"
git config user.email >nul 2>nul
if errorlevel 1 (
  git -c user.name="One-Way Door restore" -c user.email=restore@localhost commit -q -m "%MSG%" || exit /b 1
) else (
  git commit -q -m "%MSG%" || exit /b 1
)
echo Committed what the zip has beyond the bundled main:
git show --stat --format= HEAD | findstr /c:"changed"
exit /b 0

:branch
git show-ref --verify -q "refs/heads/%~1"
if not errorlevel 1 (
  echo   ok  %~1, already here
  exit /b 0
)
git show-ref --verify -q "refs/remotes/origin/%~1"
if not errorlevel 1 (
  git branch -q --track "%~1" "origin/%~1" || exit /b 1
  echo   +   %~1, from origin
  exit /b 0
)
git fetch -q "%BUNDLE%" "refs/heads/%~1:refs/heads/%~1" || exit /b 1
echo   +   %~1, from the bundle
exit /b 0

:fail
popd
exit /b 1
