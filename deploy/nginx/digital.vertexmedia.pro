# digital.vertexmedia.pro: the Vertex Digital store and its API (docs/deployment.md, ADR 0009).
# Installed by deploy/provision.sh as /etc/nginx/sites-available/digital.vertexmedia.pro; edit it
# in the repository, never on the server.
#
# nginx is the only public gateway: /api goes to the API on loopback (never its admin routes),
# the store's build assets come from disk, everything else is rendered by the store (Next.js).

server {
    listen 80;
    listen [::]:80;
    server_name digital.vertexmedia.pro;
    access_log /var/log/nginx/digital.vertexmedia.pro.access.log;
    error_log /var/log/nginx/digital.vertexmedia.pro.error.log warn;
    location ^~ /.well-known/acme-challenge/ { root /var/www/vertexdigital-acme; }
    location / { return 301 https://digital.vertexmedia.pro$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name digital.vertexmedia.pro;

    ssl_certificate /etc/letsencrypt/live/digital.vertexmedia.pro/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/digital.vertexmedia.pro/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    access_log /var/log/nginx/digital.vertexmedia.pro.access.log;
    error_log /var/log/nginx/digital.vertexmedia.pro.error.log warn;

    # Receipt uploads (S03) raise this for their own route only.
    client_max_body_size 1m;
    client_body_timeout 20s;
    server_tokens off;

    limit_conn perip 100;
    limit_req zone=general burst=50 nodelay;

    include snippets/vertexdigital-store-headers.conf;
    include snippets/vertexdigital-compression.conf;

    # --- API -----------------------------------------------------------------------------
    # Admin routes are served on the admin host only (ADR 0007). Case-insensitive, as the API
    # matches routes; a regex location wins over the /api/ prefix below.
    location ~* ^/api/admin(?:/|$) { return 404; }

    # The API documentation is disabled in production; don't forward probes for it.
    location ^~ /api/docs { return 404; }

    location /api/ {
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # The notification stream (S05 rule NT6): server-sent events, passed on as they come, open
    # for long. The API sends a comment every 25 seconds, limits each customer to 3 streams and
    # 30 connects a minute, and re-checks the session; `limit_conn perip` caps each address.
    # `text/event-stream` is not in the compression types, so nothing buffers it.
    location = /api/notifications/stream {
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }

    # The Telegram bot's webhook (S05 rules TG2, TG4): Telegram's published webhook ranges only
    # (core.telegram.org/bots/webhooks; recheck them when Telegram announces a change), bodies up
    # to 64 KB. The API also checks the secret header and the linked user and chat. Regex, so any
    # letter case or a trailing slash, which the API also routes here, cannot step around it.
    location ~* ^/api/webhooks/telegram/?$ {
        allow 149.154.160.0/20;
        allow 91.108.4.0/22;
        deny all;
        client_max_body_size 64k;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Password guessing: a tight limit on the sign-in endpoint on top of Better Auth's own.
    # Regex, so any letter case or a trailing slash cannot step around it.
    # The same for the routes that send or check an email code or a password (S01): sign-up,
    # codes, recovery and password changes, on top of the API's counters in PostgreSQL.
    location ~* ^/api/auth/(?:sign-in/email|sign-up/email|email-otp/[a-z-]+|change-password)/?$ {
        limit_req zone=vdsignin burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Deposit creation (S03, S04) and USDT TXIDs (S04 rule U8): a tight limit on top of the API's
    # per-customer counters.
    location ~* ^/api/deposits/(?:sham-cash|usdt|[0-9a-f-]{36}/txid)/?$ {
        limit_req zone=vddeposit burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Receipt uploads (S03 rule SC8): images up to 5 MB, the only large bodies the store takes.
    location ~* ^/api/deposits/[0-9a-f-]{36}/receipt/?$ {
        client_max_body_size 6m;
        client_body_timeout 60s;
        limit_req zone=vdupload burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # The Sham Cash QR images, sent by nginx when the API answers with X-Accel-Redirect
    # (FILES_ACCEL_PREFIX). Internal: never reachable by a URL; QR images only on this host.
    location ^~ /internal-files/sham_cash_qr/ {
        internal;
        alias /srv/digital.vertexmedia.pro/shared/files/sham_cash_qr/;
        include snippets/vertexdigital-store-headers.conf;
    }

    # --- Store -----------------------------------------------------------------------------
    # Hashed build assets never change: served from disk, cached for a year.
    location /_next/static/ {
        alias /srv/digital.vertexmedia.pro/current/apps/store/.next/static/;
        try_files $uri =404;
        include snippets/vertexdigital-store-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        access_log off;
    }

    # Licensed Madani Arabic files (ADR 0012): 404 until provisioned; Noto Kufi renders until then.
    location /fonts/madani/ {
        alias /srv/digital.vertexmedia.pro/fonts/madani/;
        try_files $uri =404;
        include snippets/vertexdigital-store-headers.conf;
        add_header Cache-Control "public, max-age=2592000" always;
        access_log off;
    }

    # Dotfiles and source maps are never served.
    location ~ /\. { return 404; }
    location ~ \.map$ { return 404; }

    # Every page is rendered (or served from its cache) by the store.
    location / {
        proxy_pass http://127.0.0.1:3061;
        include snippets/vertexdigital-proxy.conf;
    }
}
