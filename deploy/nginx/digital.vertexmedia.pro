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

    # Receipt uploads (F05) raise this for their own route only.
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

    # Password guessing: a tight limit on the sign-in endpoint on top of Better Auth's own.
    # Regex, so any letter case or a trailing slash cannot step around it.
    location ~* ^/api/auth/sign-in/email/?$ {
        limit_req zone=vdsignin burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
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
