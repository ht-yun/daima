@echo off
rem Register boot-time autostart: run pm2 resurrect as SYSTEM
schtasks /create /tn "CodeReview-pm2" /tr "C:\codereview\pm2-resurrect.cmd" /sc onstart /ru SYSTEM /rl highest /f
echo ---- task detail ----
schtasks /query /tn "CodeReview-pm2" /fo LIST
