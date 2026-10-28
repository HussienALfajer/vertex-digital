# Application logs of digital.vertexmedia.pro only, named explicitly. nginx logs live in
# /var/log/nginx/digital*.vertexmedia.pro.*.log and /etc/logrotate.d/nginx rotates them
# (SERVER.md rule 9). PM2's own log is rotated too (audit A10-69). `copytruncate` keeps the
# files the processes hold open, so no `create`.
/var/log/digital.vertexmedia.pro/api.*.log
/var/log/digital.vertexmedia.pro/worker.*.log
/var/log/digital.vertexmedia.pro/store.*.log
/home/vertexdigital/.pm2/pm2.log
{
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su vertexdigital vertexdigital
}
