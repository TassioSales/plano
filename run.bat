@echo off
REM Atalho para run.ps1. Exemplos: run.bat   run.bat -Static   run.bat -Test
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
