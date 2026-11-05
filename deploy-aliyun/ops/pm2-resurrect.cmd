@echo off
rem Used by the boot scheduled task: restore the saved pm2 process list
set PM2_HOME=C:\codereview\.pm2
call "C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd" resurrect
