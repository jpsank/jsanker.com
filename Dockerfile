# jsanker.com — one container: Caddy + PHP (FrankenPHP). Static pages, the PHP
# projects and their SQLite data all live behind a single process.
FROM dunglas/frankenphp:1-php8.4

RUN install-php-extensions gd pdo_sqlite opcache exif

COPY docker/php.ini /usr/local/etc/php/conf.d/zz-jsanker.ini
COPY docker/Caddyfile /etc/frankenphp/Caddyfile

WORKDIR /app
COPY src ./src
COPY bin ./bin
COPY data ./data
COPY public ./public

# Run unprivileged. APP_DATA_DIR is the only writable place (mount a volume
# there); /data and /config are Caddy's own certificate/config state.
ENV APP_DATA_DIR=/var/lib/jsanker
ARG USER=app
RUN useradd --system --no-create-home ${USER} \
 && mkdir -p ${APP_DATA_DIR} \
 && chown -R ${USER}:${USER} ${APP_DATA_DIR} /data/caddy /config/caddy \
 && setcap CAP_NET_BIND_SERVICE=+eip /usr/local/bin/frankenphp
USER ${USER}

VOLUME ["/var/lib/jsanker", "/data"]
EXPOSE 80 443
