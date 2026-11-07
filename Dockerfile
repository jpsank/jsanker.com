# jsanker.com — one container: Caddy + PHP (FrankenPHP) for the site and the PHP projects, plus gunicorn
# running two Flask apps behind Caddy: OpenChat at /openchat/ and ProTop's API at /projects/protop/api/.
# All of them keep their SQLite data in one volume.
FROM dunglas/frankenphp:1-php8.4

RUN install-php-extensions gd pdo_sqlite opcache exif

# Python for OpenChat and ProTop's API, in one virtualenv (dependencies first, so this layer is cached across code changes)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
COPY openchat-app/requirements.txt /tmp/openchat-requirements.txt
COPY protop-app/requirements.txt /tmp/protop-requirements.txt
RUN python3 -m venv /opt/openchat-venv \
 && /opt/openchat-venv/bin/pip install --no-cache-dir -r /tmp/openchat-requirements.txt -r /tmp/protop-requirements.txt \
 && rm /tmp/openchat-requirements.txt /tmp/protop-requirements.txt
ENV PYTHONDONTWRITEBYTECODE=1

COPY docker/php.ini /usr/local/etc/php/conf.d/zz-jsanker.ini
COPY docker/Caddyfile /etc/frankenphp/Caddyfile

WORKDIR /app
COPY src ./src
COPY bin ./bin
COPY data ./data
COPY public ./public
COPY openchat-app ./openchat-app
COPY protop-app ./protop-app
COPY docker/start.sh /usr/local/bin/start.sh

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

# Runs Caddy/FrankenPHP and gunicorn side by side; exits if either stops so Docker restarts the container.
ENTRYPOINT ["/usr/local/bin/start.sh"]
CMD []
