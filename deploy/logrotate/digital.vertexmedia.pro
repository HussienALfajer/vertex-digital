# Application logs of digital.vertexmedia.pro only, named explicitly. nginx logs live in
# /var/log/nginx/digital*.vertexmedia.pro.*.log and /etc/logrotate.d/nginx rotates them
# (SERVER.md rule 9).
/var/log/digital.vertexmedia.pro/api.*.log
/var/log/digital.vertexmedia.pro/worker.*.log
/var/log/digital.vertexmedia.pro/store.*.log
{
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su vertexdigital vertexdigital
    create 0640 vertexdigital vertexdigital
}
