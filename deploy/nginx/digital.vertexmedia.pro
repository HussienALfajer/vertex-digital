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
    access_log /var/log/nginx/digital.vertexmedia.pro.access.log vdprivacy;
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

    access_log /var/log/nginx/digital.vertexmedia.pro.access.log vdprivacy;
    error_log /var/log/nginx/digital.vertexmedia.pro.error.log warn;

    # Receipt uploads (S03) raise this for their own route only.
    client_max_body_size 1m;
    client_body_timeout 20s;
    server_tokens off;

    limit_conn perip 100;
    limit_req zone=general burst=50 nodelay;
    # Refusals answer 429 and count in the vertexdigital-limit jail, not the server's
    # (vertexdigital-limits.conf); the `general` zone's too, which answered nginx's default 503
    # that no jail counts (audit A10-10).
    limit_req_log_level notice;
    limit_req_status 429;
    limit_conn_status 429;

    include snippets/vertexdigital-store-headers.conf;
    include snippets/vertexdigital-compression.conf;

    # --- API -----------------------------------------------------------------------------
    # Admin routes are served on the admin host only (ADR 0007). Case-insensitive, as the API
    # matches routes; a regex location wins over the /api/ prefix below.
    location ~* ^/api/admin(?:/|$) { return 404; }

    # The API documentation is disabled in production; don't forward probes for it.
    location ^~ /api/docs { return 404; }
    # The store's cache refresh (S09 rule SF4) is for the worker on 127.0.0.1 only; the route also
    # refuses anything proxied. Matched on the decoded path, so %5F does not get around it.
    location ~* ^/_internal(?:/|$) { return 404; }

    location /api/ {
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # The notification stream (S05 rule NT6): server-sent events, passed on as they come, open
    # for long. The API sends a comment every 25 seconds, limits each customer to 3 streams and
    # 30 connects a minute, and re-checks the session. Open streams count in `vdstream`, not in the
    # `perip` slots every other request of the address shares (audit A07-32).
    # `text/event-stream` is not in the compression types, so nothing buffers it.
    location = /api/notifications/stream {
        limit_conn vdstream 300;
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

    # Supplier webhooks (S08 rule F4): signed by HMAC with a timestamp, bodies up to 64 KB, the
    # API's own limit too. Suppliers publish no fixed ranges, so no allow list here. Regex, so any
    # letter case or a trailing slash cannot step around it.
    location ~* ^/api/webhooks/suppliers/[a-z0-9]+/?$ {
        client_max_body_size 64k;
        limit_req zone=vdwebhook burst=30 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Purchases (S08 rule O1) and cart checkouts (S10 rule CT9, one request each): POST is
    # limited (the zone's key is empty for GET), on top of the API's per-customer counters.
    location ~* ^/api/(?:orders|checkouts)/?$ {
        limit_req zone=vdpurchase burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Player checks (S09 rule PV4): POST only (the zone's key is empty otherwise), on top of the
    # API's per-customer and per-address counters.
    location ~* ^/api/player-checks/?$ {
        limit_req zone=vdplayercheck burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Gift and receipt data and images (S10 rules SH1, SH2, SH5), public: on top of the API's 60
    # a minute per address. The API sets the cache headers and reads no cookie.
    location ~* ^/api/shares/ {
        limit_req zone=vdshare burst=20 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Receipt verification data (S21 VF2, VF3), public: on top of the API's 60 a minute per
    # address. The API sets the cache headers and reads no cookie.
    location ~* ^/api/verify/ {
        limit_req zone=vdverify burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Merchant certificate data (S23 ID7), public: on top of the API's 60 a minute per address.
    location ~* ^/api/certificates/ {
        limit_req zone=vdcertificate burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Direct buy link targets (S22 DL2), public: on top of the API's 60 a minute per address.
    location ~* ^/api/q/ {
        limit_req zone=vdquick burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # The public whole-catalog reads the browser makes (S09 SR2: the search dialog and the cart's
    # price check; the storefront), each computing every pack's routing: a zone of their own, in
    # place of the general one here and tighter (audit A03-4). The store's server reads them on
    # 127.0.0.1, not through here.
    location ~* ^/api/catalog/(?:storefront|search-index)/?$ {
        limit_req zone=vdcatalog burst=30 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Catalog images (S06 CT10, S09 SF5; 2026-10-30): public, immutable and never replaced, so nginx
    # sends them from disk without asking the API or the database. An X-Accel-Redirect answer cannot
    # be kept by `proxy_cache` (nginx follows the header before it would store anything), and every
    # image would still cost the API a query. Keys are deterministic (`catalog_image/<last 2 of
    # id>/<id>[.w<width>].webp`). What is not on disk yet (a width not made yet, a width above the
    # stored image's, an unknown id) goes to the API. A swept image stays until `system.sweep-files`
    # removes it minutes later, and an orphan's bytes are a catalog image an admin uploaded: both
    # are as public as the browsers' year-long copies.
    location ~ "^/api/catalog/images/(?<vd_image_id>[0-9a-f-]{34}(?<vd_image_shard>[0-9a-f]{2}))$" {
        limit_conn vdimageconn 400;
        limit_req zone=vdimage burst=400 nodelay;
        root /srv/digital.vertexmedia.pro/shared/files;
        try_files /catalog_image/$vd_image_shard/$vd_image_id$vd_catalog_image_width.webp @vd_catalog_image;
        include snippets/vertexdigital-store-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Content-Disposition "inline" always;
    }
    location @vd_catalog_image {
        limit_conn vdimageconn 400;
        limit_req zone=vdimage burst=400 nodelay;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # A customer's own images, read with the session, a few to a page: not worth a place in `general`
    # next to the pages (the API checks the owner and sets the cache headers). The uploads have
    # their own locations.
    location ~* "^/api/(?:merchant/logo/[0-9a-f-]{36}|merchant/application/photo/[0-9a-f-]{36}|deposits/sham-cash/qr/[a-z]+|support/tickets/[0-9a-f-]{36}/attachments/[0-9a-f-]{36})/?$" {
        limit_req zone=vdimage burst=100 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Code reveals (S08 rule C2), on top of the API's per-customer counter.
    location ~* "^/api/orders/[0-9a-f-]{36}/codes/[0-9a-f-]{36}/reveal/?$" {
        limit_req zone=vdreveal burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Password guessing: a tight limit on the sign-in endpoint on top of Better Auth's own.
    # Regex, so any letter case or a trailing slash cannot step around it.
    # The same for the routes that send or check an email code or a password (S01): sign-up,
    # codes, recovery and password changes, on top of the API's counters in PostgreSQL; and the
    # passkey ceremonies (S22: the public sign-in and its options, which store a challenge each)
    # and the passkey grant's password check (audit A01-2).
    location ~* ^/api/(?:auth/(?:sign-in/(?:email|passkey)|sign-up/email|email-otp/[a-z-]+|change-password|passkey/[a-z-]+)|account/passkeys/authorize)/?$ {
        limit_req zone=vdsignin burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Deposit creation (S03, S04), USDT TXIDs (S04 rule U8), requotes and cancellations (rule SC6,
    # audit A02-25): a tight limit on top of the API's per-customer counters.
    location ~* "^/api/deposits/(?:sham-cash|usdt|[0-9a-f-]{36}/(?:txid|quote|cancel))/?$" {
        limit_req zone=vddeposit burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Receipt uploads (S03 rule SC8): images up to 5 MB, the only large bodies the store takes.
    location ~* "^/api/deposits/[0-9a-f-]{36}/receipt/?$" {
        client_max_body_size 6m;
        client_body_timeout 60s;
        limit_req zone=vdupload burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # A merchant's receipt logo (S21 BR3): one image of 1 MB with its multipart wrapping.
    location ~* ^/api/merchant/logo/?$ {
        client_max_body_size 2m;
        client_body_timeout 60s;
        limit_req zone=vdupload burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # A merchant application's shop photo (S20 MA3): one image of 5 MB with its multipart wrapping.
    location ~* ^/api/merchant/application/photo/?$ {
        client_max_body_size 6m;
        client_body_timeout 60s;
        limit_req zone=vdupload burst=5 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3060;
        include snippets/vertexdigital-proxy.conf;
    }

    # Support tickets and messages (S12 TK11): up to 3 images of 5 MB, 16 MB a request.
    location ~* "^/api/support/tickets(?:/[0-9a-f-]{36}/messages)?/?$" {
        client_max_body_size 16m;
        client_body_timeout 60s;
        limit_req zone=vdticket burst=5 nodelay;
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

    # Ticket images (S12 TK11), sent by nginx after the API checked the customer's own ticket holds
    # the file; the API sets `no-store`.
    location ^~ /internal-files/ticket_attachment/ {
        internal;
        alias /srv/digital.vertexmedia.pro/shared/files/ticket_attachment/;
        include snippets/vertexdigital-store-headers.conf;
    }

    # A merchant's receipt logo (S21 BR3) and an application's shop photo (S20 MA3), sent by nginx
    # after the API checked they are the customer's own; the API sets `no-store`.
    location ^~ /internal-files/merchant_logo/ {
        internal;
        alias /srv/digital.vertexmedia.pro/shared/files/merchant_logo/;
        include snippets/vertexdigital-store-headers.conf;
    }
    location ^~ /internal-files/merchant_shop_photo/ {
        internal;
        alias /srv/digital.vertexmedia.pro/shared/files/merchant_shop_photo/;
        include snippets/vertexdigital-store-headers.conf;
    }

    # Catalog images (S06 rule CT10), public and immutable (the API sets `Cache-Control`), sent
    # by nginx after the API checked the id is a catalog image. Catalog images only on this host.
    location ^~ /internal-files/catalog_image/ {
        internal;
        alias /srv/digital.vertexmedia.pro/shared/files/catalog_image/;
        include snippets/vertexdigital-store-headers.conf;
    }

    # --- Store -----------------------------------------------------------------------------
    # Hashed build assets never change: served from disk, cached for a year.
    location /_next/static/ {
        limit_req zone=vdstatic burst=400 nodelay;
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

    # The favicon (src/app/favicon.ico): browsers ask for it on their own, so it must never 404
    # (a 404 repeated by a browser trips the server-wide nginx-4xx-flood jail). The store answers
    # it with `max-age=0`; a day in the browser's cache is enough for a file that rarely changes.
    location = /favicon.ico {
        proxy_pass http://127.0.0.1:3061;
        include snippets/vertexdigital-proxy.conf;
        proxy_hide_header Cache-Control;
        include snippets/vertexdigital-store-headers.conf;
        add_header Cache-Control "public, max-age=86400" always;
        access_log off;
    }

    # Dotfiles and source maps are never served.
    location ~ /\. { return 404; }
    location ~ \.map$ { return 404; }

    # The public gift and receipt pages (S10 rules GF5, RC2, SH5): rendered per request by the
    # store, which reads /api/shares/ with the visitor's address. The pages carry
    # `<meta name="referrer" content="no-referrer">` and the store adds `X-Robots-Tag: noindex`.
    location ~ ^/(?:g|r)/ {
        limit_req zone=vdshare burst=20 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3061;
        include snippets/vertexdigital-proxy.conf;
    }

    # The public verification page of a receipt's QR (S21 VF2): rendered per request by the
    # store, which reads /api/verify/ with the visitor's address; `noindex`.
    location ~ ^/v/ {
        limit_req zone=vdverify burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3061;
        include snippets/vertexdigital-proxy.conf;
    }

    # Direct buy links (S22 DL1, DL2): resolved per request by the store, which reads /api/q/ with
    # the visitor's address and redirects to the pack.
    location ~ ^/q/ {
        limit_req zone=vdquick burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3061;
        include snippets/vertexdigital-proxy.conf;
    }

    # The public page of a merchant certificate's QR (S23 ID7): rendered per request by the store,
    # which reads /api/certificates/ with the visitor's address; `noindex`.
    location ~ ^/m/ {
        limit_req zone=vdcertificate burst=10 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:3061;
        include snippets/vertexdigital-proxy.conf;
    }

    # Every page is rendered (or served from its cache) by the store.
    location / {
        proxy_pass http://127.0.0.1:3061;
        include snippets/vertexdigital-proxy.conf;
    }
}
