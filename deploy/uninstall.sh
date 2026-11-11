#!/usr/bin/env bash
# Removes Comffee CCTV from this server.
#
# Always removes the two services, the code in /opt/comffee-cctv, the Node.js and MediaMTX copies
# it installed, its Caddy site and its firewall rules. Asks before deleting the WireGuard key and
# before deleting recordings, the database, secrets and settings. Leaves Caddy, ffmpeg and the
# WireGuard tools installed.
#
# Usage:
#   sudo bash /opt/comffee-cctv/deploy/uninstall.sh [--keep-data]

set -euo pipefail

readonly APP_DIR="/opt/comffee-cctv"
readonly RUNTIME_DIR="/usr/local/lib/comffee-cctv"
readonly CONFIG_DIR="/etc/comffee-cctv"
readonly CONFIG_PATH="$CONFIG_DIR/hub.json"
readonly DEFAULT_DATA_DIR="/var/lib/comffee-cctv"
readonly SERVICE_USER="comffee-cctv"
readonly WG_IF="wg0"
readonly WG_CONF="/etc/wireguard/wg0.conf"
readonly FW_CHAIN="COMFFEE-CCTV-IN"
readonly CADDYFILE="/etc/caddy/Caddyfile"
readonly CADDYFILE_BACKUP="/etc/caddy/Caddyfile.before-comffee-cctv"
readonly UNITS=(comffee-cctv-hub.service comffee-cctv-mediamtx.service)

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nWarning: %s\n' "$*" >&2; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

# ask <question> <exact answer>: true only when the person types exactly that answer.
ask() {
  local answer=""
  printf '\n%s ' "$1" 2>/dev/null >/dev/tty || return 1
  IFS= read -r answer 2>/dev/null </dev/tty || return 1
  [ "$answer" = "$2" ]
}

data_dir_from_config() {
  local node="$RUNTIME_DIR/node/bin/node" dir=""
  if [ -f "$CONFIG_PATH" ] && [ -x "$node" ]; then
    dir=$("$node" -e '
      const fs = process.getBuiltinModule("node:fs");
      try { const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dataDir; if (typeof v === "string") process.stdout.write(v); } catch {}
    ' "$CONFIG_PATH" 2>/dev/null || true)
  fi
  printf '%s' "${dir:-$DEFAULT_DATA_DIR}"
}

# Refuses anything that is not a plain folder at least two levels deep, so a damaged setting can
# never point the delete at / or a system folder.
safe_data_dir() {
  [[ $1 =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ $1 != *..* ]] && [[ $1 =~ ^/[^/]+/[^/]+ ]] || return 1
  case "${1%/}" in
    /usr/* | /etc/* | /bin/* | /sbin/* | /lib/* | /lib64/* | /boot/* | /proc/* | /sys/* | /dev/* | /run/* | /var/lib | /var/log | /home/* | /root/*) return 1 ;;
  esac
  return 0
}

# Removing our chain is safe only when SSH stays reachable without it.
remove_chain() {
  local ipt=$1 rules
  if ! "$ipt" -w -S "$FW_CHAIN" >/dev/null 2>&1; then return 0; fi
  rules=$("$ipt" -w -S INPUT)
  if [[ $rules == *"-P INPUT ACCEPT"* ]] ||
    { [[ $rules == *"--dport 22 -j ACCEPT"* ]] && [[ $rules == *"ESTABLISHED"*"-j ACCEPT"* ]]; }; then
    while "$ipt" -w -C INPUT -j "$FW_CHAIN" 2>/dev/null; do
      "$ipt" -w -D INPUT -j "$FW_CHAIN"
    done
    "$ipt" -w -F "$FW_CHAIN"
    "$ipt" -w -X "$FW_CHAIN"
  else
    warn "Kept the $ipt chain $FW_CHAIN: without it SSH might be blocked. Remove it by hand once SSH is allowed elsewhere."
  fi
}

main() {
  local keep_data=no delete_data=no delete_wg=no data_dir unit
  while [ $# -gt 0 ]; do
    case "$1" in
      --keep-data) keep_data=yes; shift ;;
      -h | --help)
        printf 'Removes Comffee CCTV. Usage: sudo bash %s [--keep-data]\n' "$0"
        exit 0
        ;;
      *) die "Unknown option: $1" ;;
    esac
  done
  if [ "$(id -u)" -ne 0 ]; then die "Run this as root, for example: sudo bash $0"; fi

  data_dir=$(data_dir_from_config)
  data_dir=${data_dir%/}

  printf 'This removes Comffee CCTV from this server.\n'
  if [ -s "$WG_CONF" ] && ask "Also delete the hub WireGuard key? Every router location would then need its router script pasted again after a new install. Type yes to delete it:" yes; then
    delete_wg=yes
  fi
  if [ "$keep_data" = no ]; then
    if ! safe_data_dir "$data_dir"; then
      warn "The data folder setting '$data_dir' looks wrong, so it will not be deleted."
    elif ask "Delete ALL recordings, the database, the secrets in $data_dir and the settings in $CONFIG_DIR? This cannot be undone. Type DELETE to confirm:" DELETE; then
      delete_data=yes
    fi
  fi

  say "Stopping and removing the services"
  for unit in "${UNITS[@]}"; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$unit"
  done
  systemctl daemon-reload
  systemctl reset-failed "${UNITS[@]}" >/dev/null 2>&1 || true

  if [ -f "$CADDYFILE" ] && grep -q "Comffee CCTV" "$CADDYFILE"; then
    say "Removing the Caddy site"
    if [ -f "$CADDYFILE_BACKUP" ]; then
      mv -f "$CADDYFILE_BACKUP" "$CADDYFILE"
    else
      printf '# Emptied by the Comffee CCTV uninstaller.\n' >"$CADDYFILE"
    fi
    systemctl reload-or-restart caddy.service >/dev/null 2>&1 || warn "Caddy did not reload; check 'systemctl status caddy'."
  fi

  say "Removing the firewall rules"
  remove_chain iptables
  if ip6tables -w -S INPUT >/dev/null 2>&1; then remove_chain ip6tables; fi
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || warn "Could not save the firewall rules."
  fi

  say "Stopping the WireGuard tunnel"
  systemctl disable --now "wg-quick@$WG_IF.service" >/dev/null 2>&1 || true
  if [ "$delete_wg" = yes ]; then
    rm -f "$WG_CONF"
    printf 'Deleted the hub WireGuard key.\n'
  elif [ -f "$WG_CONF" ]; then
    printf 'Kept the hub WireGuard key in %s.\n' "$WG_CONF"
  fi

  say "Removing the program files"
  rm -rf "$APP_DIR" "$RUNTIME_DIR"

  if [ "$delete_data" = yes ]; then
    say "Deleting recordings, database, secrets and settings"
    rm -rf --one-file-system -- "$data_dir"
    rm -rf -- "$CONFIG_DIR"
    if id -u "$SERVICE_USER" >/dev/null 2>&1; then userdel "$SERVICE_USER" >/dev/null 2>&1 || true; fi
    if getent group "$SERVICE_USER" >/dev/null 2>&1; then groupdel "$SERVICE_USER" >/dev/null 2>&1 || true; fi
  else
    printf '\nKept recordings, database and secrets in %s and settings in %s.\n' "$data_dir" "$CONFIG_DIR"
    printf 'Running deploy/install.sh again later picks them up.\n'
  fi

  printf '\nComffee CCTV has been removed.\n'
}

# The whole script is read before any file is deleted, because main runs last.
main "$@"
exit $?
