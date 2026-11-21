#!/bin/sh
# Create the NAS discord-bridge directories.
# app/ and secrets/ are root-owned so the service cannot rewrite its code or credentials.
# queue/, state/, and logs/ belong to the service user. Those are the only ReadWritePaths.
# This script does not print secret values and does not start the service.
set -eu

ROOT="${DBR_INSTALL_ROOT:-/srv/ssd1/discord-bridge}"
USER_NAME="${DBR_SERVICE_USER:-dbridge}"
GROUP_NAME="${DBR_SERVICE_GROUP:-dbridge}"

if [ "$(id -u)" -ne 0 ]; then
  echo "install must run as root" >&2
  exit 1
fi

install -d -o root -g root -m 755 "$ROOT"
install -d -o root -g root -m 755 "$ROOT/app"
install -d -o root -g root -m 700 "$ROOT/secrets"
install -d -o "$USER_NAME" -g "$GROUP_NAME" -m 700 "$ROOT/queue"
install -d -o "$USER_NAME" -g "$GROUP_NAME" -m 700 "$ROOT/state"
install -d -o "$USER_NAME" -g "$GROUP_NAME" -m 700 "$ROOT/logs"

chown -R root:root "$ROOT/app" "$ROOT/secrets"
chmod 755 "$ROOT/app"
chmod -R go-w "$ROOT/app"
chmod 700 "$ROOT/secrets"
find "$ROOT/secrets" -type d -exec chmod 700 {} \;
find "$ROOT/secrets" -type f -exec chown root:root {} \; -exec chmod 600 {} \;

echo "installed $ROOT"
