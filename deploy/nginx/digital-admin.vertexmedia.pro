# digital-admin.vertexmedia.pro: the Vertex Digital admin panel (docs/deployment.md, ADR 0007,
# 0009). Installed by deploy/provision.sh as /etc/nginx/sites-available/digital-admin.vertexmedia.pro;
# edit it in the repository, never on the server.
#
# The panel's build is served from the current release; only the admin API (/api/admin) and the
# ALTCHA challenge its sign-in may need are proxied. Customer routes are not served here.

server {
    listen 80;
    listen [::]:80;
    server_name digital-admin.vertexmedia.pro;
    access_log /var/log/nginx/digital-admin.vertexmedia.pro.access.log;
    error_log /var/log/nginx/digital-admin.vertexmedia.pro.error.log warn;
    location ^~ /.well-known/acme-challenge/ { root /var/www/vertexdigital-acme; }
    location / { return 301 https://digital-admin.vertexmedia.pro$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name digital-admin.vertexmedia.pro;

    ssl_certificate /etc/letsencrypt/live/digital-admin.vertexmedia.pro/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/digital-admin.vertexmedia.pro/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    access_log /var/log/nginx/digital-admin.vertexmedia.pro.access.log;
    error_log /var/log/nginx/digital-admin.vertexmedia.pro.error.log warn;

    root /srv/digital.vertexmedia.pro/current/apps/admin/dist;
    index index.html;

    client_max_body_size 1m;
    client_body_timeout 20s;
    server_tokens off;

    limit_conn perip 100;
    limit_req zone=general burst=50 nodelay;

    include snippets/vertexdigital-admin-headers.conf;
    include snippets/vertexdigital-compression.conf;

    # --- API -----------------------------------------------------------------------------
    # Password and TOTP guessing: a tight limit on top of Better Auth's own and its ALTCHA step.
    # Regex locations match in order: this one must come before the general admin route.
    location ~* ^/api/admin/(?:auth/(?:sign-in/email|two-factor/[a-z-]+|change-password)|me/reauthenticate)/?$ {
        limit_req zone=vdsignin burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # QR image uploads (S03): images up to 5 MB, the only large bodies the panel sends.
    location ~* ^/api/admin/deposit-settings/qr/?$ {
        client_max_body_size 6m;
        client_body_timeout 60s;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Admin routes only. Case-insensitive, as the API matches routes.
    location ~* ^/api/admin/ {
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # The proof of work the admin sign-in asks for after repeated failures (ADR 0008).
    location = /api/altcha/challenge {
        limit_req zone=vdsignin burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Receipts and QR images (S03), sent by nginx when the API answers with X-Accel-Redirect
    # (FILES_ACCEL_PREFIX) after its own access check. Internal: never reachable by a URL.
    location ^~ /internal-files/ {
        internal;
        alias /srv/digital.vertexmedia.pro/shared/files/;
        include snippets/vertexdigital-admin-headers.conf;
    }

    # Every other API route belongs to the store's host.
    location /api/ { return 404; }

    # --- Static files ----------------------------------------------------------------------
    # Hashed build assets never change: cache them for a year.
    location /assets/ {
        try_files $uri =404;
        include snippets/vertexdigital-admin-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        access_log off;
    }

    location /fonts/madani/ {
        alias /srv/digital.vertexmedia.pro/fonts/madani/;
        try_files $uri =404;
        include snippets/vertexdigital-admin-headers.conf;
        add_header Cache-Control "public, max-age=2592000" always;
        access_log off;
    }

    location ~ /\. { return 404; }
    location ~ \.map$ { return 404; }

    # The SPA: every other path renders index.html, always revalidated so a deploy takes effect
    # on the next page load.
    location / {
        try_files $uri /index.html;
        include snippets/vertexdigital-admin-headers.conf;
        add_header Cache-Control "no-cache" always;
    }
}
