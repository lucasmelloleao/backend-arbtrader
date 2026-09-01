@echo off
REM Build e run da ponte Dukascopy (JForex SDK).
REM Uso: run-bridge.bat [porta]
setlocal
cd /d "%~dp0"
set PORT=%1
if "%PORT%"=="" set PORT=9100
echo Compilando...
javac -encoding UTF-8 -cp "lib\DDS2-jClient-JForex-3.6.51.jar;lib\JForex-API-2.13.99.jar" -d out src\bridge\DukascopyBridge.java
if errorlevel 1 exit /b 1
echo Iniciando ponte na porta %PORT%...
java -cp "lib\DDS2-jClient-JForex-3.6.51.jar;lib\JForex-API-2.13.99.jar;out" bridge.DukascopyBridge %PORT%
