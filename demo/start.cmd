@echo off
rem Starts the One-Way Door demo Control Centre and opens it in your browser. Needs Java 21+ and git. No Docker.
rem Usage: demo\start.cmd                       the UI at http://localhost:7070
rem        demo\start.cmd --owd.run=incident    headless: incident ^| matrix ^| prepare (exit 0 = as expected)
rem To rebuild after changing the Control Centre, delete demo\control-centre\target first.
setlocal
chcp 65001 >nul
set "HERE=%~dp0"
set "JAR=%HERE%control-centre\target\control-centre.jar"
if not exist "%JAR%" (
  echo Building the Control Centre. The first build downloads dependencies and takes a few minutes...
  pushd "%HERE%control-centre"
  call mvnw.cmd -B -q package -DskipTests
  if errorlevel 1 ( popd & exit /b 1 )
  popd
)
set "JAVA=java"
if defined JAVA_HOME set "JAVA=%JAVA_HOME%\bin\java"
pushd "%HERE%.."
"%JAVA%" -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -jar "%JAR%" %*
set "CODE=%ERRORLEVEL%"
popd
exit /b %CODE%
