@echo off
rem Stop the pm2 daemon that runs under the fixed PM2_HOME
set PM2_HOME=C:\codereview\.pm2
call "C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd" kill
