@echo off
rem Start CodeReview under a fixed PM2_HOME so SYSTEM can resurrect it at boot
set PM2_HOME=C:\codereview\.pm2
cd /d C:\codereview\src-app
call "C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd" start ecosystem.config.cjs
call "C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd" save
