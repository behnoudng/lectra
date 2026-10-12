FROM python:3.12.14-slim-bookworm AS sqlite-build
RUN --mount=type=secret,id=cloud_ca \
    if [ -f /run/secrets/cloud_ca ]; then cp /run/secrets/cloud_ca /etc/ssl/certs/ca-certificates.crt; fi \
 && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends build-essential tcl curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN --mount=type=secret,id=cloud_ca \
    if [ -f /run/secrets/cloud_ca ]; then export CURL_CA_BUNDLE=/run/secrets/cloud_ca; fi \
 && curl --fail --location --proto '=https' --tlsv1.2 https://codeload.github.com/sqlite/sqlite/tar.gz/refs/tags/version-3.53.1 -o sqlite.tar.gz \
 && echo '71e13e0fa5b925b28a7c5b5515079e8ec21c739b1ddc9cbb87e6524626317c15  sqlite.tar.gz' | sha256sum -c - \
 && tar -xzf sqlite.tar.gz --strip-components=1 \
 && ./configure --prefix=/opt/sqlite --enable-fts5 --disable-static \
 && make -j2 && make install
FROM python:3.12.14-slim-bookworm
RUN --mount=type=secret,id=cloud_ca \
    if [ -f /run/secrets/cloud_ca ]; then cp /run/secrets/cloud_ca /etc/ssl/certs/ca-certificates.crt; fi \
 && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=sqlite-build /opt/sqlite/lib/libsqlite3.so* /usr/local/lib/
RUN ldconfig && python -c 'import sqlite3; assert sqlite3.sqlite_version == "3.53.1", sqlite3.sqlite_version'
WORKDIR /app
COPY requirements.lock ./requirements.lock
RUN --mount=type=secret,id=cloud_ca \
    if [ -f /run/secrets/cloud_ca ]; then export PIP_CERT=/run/secrets/cloud_ca; fi \
 && pip install --no-cache-dir -r requirements.lock
COPY . .
ENV PYTHONUNBUFFERED=1 APP_DATA_DIR=/data BACKUP_DIR=/backups
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
