#!/usr/bin/env bash
# Comffee CCTV hub installer.
#
# Runs as root on Ubuntu 24.04 (x86_64 or aarch64). Safe to run again at any time: every step
# checks what is already in place, keeps existing keys, settings and recordings, and only changes
# what is missing or out of date. deploy/update.sh runs it again after pulling new code.
#
# Runs unattended too (no questions asked): deploy/cloud-init.yaml.template uses it to set up a new
# cloud server on first boot, with a setup code made by the desktop app (--setup-code).
#
# Usage:
#   sudo bash deploy/install.sh [--host <domain>|auto] [--public-ip <ipv4>] [--repo-dir <folder>] [--data-dir <folder>]
#                               [--from-git <https url> [--ref <tag or branch>]] [--setup-code <code>]

set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

# Pinned versions. Each download is checked against the hash written here AND against the
# checksum list published with that release; both must match or nothing is installed.
readonly NODE_VERSION="v24.22.2"
readonly NODE_SHA256_X64="48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75"
readonly NODE_SHA256_ARM64="eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8"
readonly MEDIAMTX_VERSION="v1.21.3"
readonly MEDIAMTX_SHA256_AMD64="0a2ea7eba96023631efa1bea7804823a9145b043b6646a8a05798d4ac24ed635"
readonly MEDIAMTX_SHA256_ARM64="27f038237cb5f77a724f6afc58eca2798f2bc4edf9989895631a80eeb41a4fe2"
# Primary key fingerprint of the Caddy package signing key (Cloudsmith "caddy/stable").
readonly CADDY_KEY_FINGERPRINT="65760C51EDEA2017CEA2CA15155B6D79CA56EA34"

readonly APP_DIR="/opt/comffee-cctv"
readonly RUNTIME_DIR="/usr/local/lib/comffee-cctv"
readonly CONFIG_DIR="/etc/comffee-cctv"
readonly CONFIG_PATH="$CONFIG_DIR/hub.json"
readonly MEDIAMTX_CONFIG="$CONFIG_DIR/mediamtx.yml"
readonly DEFAULT_DATA_DIR="/var/lib/comffee-cctv"
readonly SERVICE_USER="comffee-cctv"
readonly HUB_PORT=8080
readonly WG_IF="wg0"
readonly WG_ADDRESS="10.77.0.1/16"
readonly WG_PORT=51820
readonly WG_MTU=1420
readonly WEBRTC_UDP_PORT=8189
readonly FW_CHAIN="COMFFEE-CCTV-IN"
readonly CADDY_KEYRING="/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
readonly CADDY_LIST="/etc/apt/sources.list.d/caddy-stable.list"
readonly CADDYFILE="/etc/caddy/Caddyfile"
readonly CADDYFILE_BACKUP="/etc/caddy/Caddyfile.before-comffee-cctv"
readonly UNITS=(comffee-cctv-mediamtx comffee-cctv-hub)

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
HOST=""
PUBLIC_IP=""
REPO_DIR=""
GIT_URL=""
GIT_REF=""
SETUP_CODE=""
DATA_DIR=""
TMP=""
NODE_ARCH=""
NODE_SHA=""
MTX_ARCH=""
MTX_SHA=""
NODE_BIN="$RUNTIME_DIR/node/bin/node"
MEDIAMTX_BIN="$RUNTIME_DIR/mediamtx/mediamtx"
WG_PUBKEY=""
NEEDS_SETUP=""

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '\nWarning: %s\n' "$*" >&2; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Installs or repairs the Comffee CCTV hub on Ubuntu 24.04.

  sudo bash deploy/install.sh [options]

Options:
  --host <domain>       Web address of the dashboard, for example cctv.example.com. Point the
                        domain's A record at this server first. Default (or "auto"): the address
                        already in use, or <public-ip-with-dashes>.sslip.io (a free name for this
                        server).
  --public-ip <ipv4>    This server's public IPv4 address. Default: detected automatically.
  --repo-dir <folder>   Folder that holds the Comffee CCTV code. Default: the folder above this
                        script. The code is copied to /opt/comffee-cctv when it is somewhere else.
  --from-git <url>      Download the code from this https git address instead of using a folder.
  --ref <tag or branch> With --from-git: the release tag or branch to install. Default: the main branch.
  --data-dir <folder>   Where recordings, the database and secrets are kept.
                        Default: the folder already in use, or /var/lib/comffee-cctv.
  --setup-code <code>   Use this one-time setup code for the owner account instead of printing a
                        new one (base32, 26 to 64 characters; the hub stores only its hash).
                        The desktop app passes one when it creates the server for you.
  -h, --help            Show this help.
EOF
}

need_value() {
  if [ "$2" -lt 2 ]; then die "$1 needs a value (see --help)."; fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --host) need_value "$1" $#; HOST=$2; shift 2 ;;
      --host=*) HOST=${1#*=}; shift ;;
      --public-ip) need_value "$1" $#; PUBLIC_IP=$2; shift 2 ;;
      --public-ip=*) PUBLIC_IP=${1#*=}; shift ;;
      --repo-dir) need_value "$1" $#; REPO_DIR=$2; shift 2 ;;
      --repo-dir=*) REPO_DIR=${1#*=}; shift ;;
      --data-dir) need_value "$1" $#; DATA_DIR=$2; shift 2 ;;
      --data-dir=*) DATA_DIR=${1#*=}; shift ;;
      --from-git) need_value "$1" $#; GIT_URL=$2; shift 2 ;;
      --from-git=*) GIT_URL=${1#*=}; shift ;;
      --ref) need_value "$1" $#; GIT_REF=$2; shift 2 ;;
      --ref=*) GIT_REF=${1#*=}; shift ;;
      --setup-code) need_value "$1" $#; SETUP_CODE=$2; shift 2 ;;
      --setup-code=*) SETUP_CODE=${1#*=}; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "Unknown option: $1 (see --help)." ;;
    esac
  done
  if [ "$HOST" = "auto" ]; then HOST=""; fi
  if [ -n "$GIT_URL" ]; then
    [ -z "$REPO_DIR" ] || die "Use --from-git or --repo-dir, not both."
    valid_git_url "$GIT_URL" || die "--from-git must be an https:// git address such as https://github.com/owner/comffee-cctv.git"
  fi
  if [ -n "$GIT_REF" ]; then
    [ -n "$GIT_URL" ] || die "--ref works only together with --from-git."
    valid_git_ref "$GIT_REF" || die "--ref must be a release tag or branch name such as v1.0.0 or main."
  fi
  if [ -n "$SETUP_CODE" ]; then
    SETUP_CODE=${SETUP_CODE^^}
    SETUP_CODE=${SETUP_CODE//[[:space:]-]/}
    [[ $SETUP_CODE =~ ^[A-Z2-7]{26,64}$ ]] ||
      die "--setup-code must be base32 (letters A-Z and digits 2-7), 26 to 64 characters."
  fi
}

# A plain https address without a user name or password in it.
valid_git_url() {
  [[ $1 =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%+-]+)+/?$ ]]
}

valid_git_ref() {
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ ]] && [[ $1 != *..* ]] && [[ $1 != */ ]]
}

valid_ipv4() {
  local ip=$1 part
  if [[ ! $ip =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then return 1; fi
  local IFS=.
  for part in $ip; do
    if ((10#$part > 255)); then return 1; fi
  done
  return 0
}

valid_host() {
  [[ $1 =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] && [ ${#1} -le 253 ]
}

# A plain absolute path: it goes into systemd units and the MediaMTX config.
valid_data_dir() {
  [[ $1 =~ ^/[A-Za-z0-9._/-]+$ ]] && [[ $1 != *..* ]] && [[ $1 =~ ^/[^/]+/.+ ]]
}

# Replaces {{KEY}} placeholders in a template. Usage: render <template> <output> KEY=value...
render() {
  local src=$1 dst=$2 content pair key val
  shift 2
  [ -f "$src" ] || die "Missing template $src."
  content=$(<"$src")
  for pair in "$@"; do
    key=${pair%%=*}
    val=${pair#*=}
    content=${content//"{{$key}}"/"$val"}
  done
  if [[ $content =~ \{\{[A-Z_]+\}\} ]]; then die "Template $src still has an unfilled ${BASH_REMATCH[0]}."; fi
  printf '%s\n' "$content" >"$dst"
}

fetch() {
  curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --retry-delay 2 -m 900 -o "$2" "$1" ||
    die "Download failed: $1"
}

sha256_of() {
  local out
  out=$(sha256sum "$1")
  printf '%s' "${out%% *}"
}

# Hash listed for a file name in a checksum list ("<hash>  <name>" or "<hash> *<name>").
listed_hash() {
  awk -v n="$2" '{ f = $2; sub(/^\*/, "", f); if (f == n) print $1 }' "$1"
}

# Usage: verify_download <file> <published name> <pinned hash> <release checksum list>
verify_download() {
  local actual listed
  actual=$(sha256_of "$1")
  if [ "$actual" != "$3" ]; then
    die "Checksum mismatch for $2 (expected $3, got $actual). Nothing was installed."
  fi
  listed=$(listed_hash "$4" "$2")
  if [ "$listed" != "$3" ]; then
    die "$2 is not listed with the expected checksum in the release checksum file. Nothing was installed."
  fi
}

# True when <dir>/<binary> was unpacked from the pinned archive and has not changed since.
runtime_ok() {
  local dir=$1 bin=$2 want=$3 have_archive="" have_bin=""
  if [ ! -x "$dir/$bin" ] || [ ! -f "$dir/.comffee-verified" ]; then return 1; fi
  read -r have_archive have_bin <"$dir/.comffee-verified" || return 1
  [ "$have_archive" = "$want" ] && [ "$(sha256_of "$dir/$bin")" = "$have_bin" ]
}

# Usage: unpack <archive> <dest dir> <binary inside> <archive hash> [extra tar options]
unpack() {
  local archive=$1 dest=$2 bin=$3 hash=$4
  shift 4
  rm -rf "$dest.new"
  install -d -m 0755 "$dest.new"
  tar -xf "$archive" -C "$dest.new" --no-same-owner "$@"
  [ -x "$dest.new/$bin" ] || die "$(basename "$archive") did not contain $bin."
  printf '%s %s\n' "$hash" "$(sha256_of "$dest.new/$bin")" >"$dest.new/.comffee-verified"
  chown -R root:root "$dest.new"
  chmod -R u+rwX,go+rX,go-w "$dest.new"
  rm -rf "$dest"
  mv "$dest.new" "$dest"
}

apt_get() {
  apt-get -o DPkg::Lock::Timeout=600 -y -q "$@"
}

# On a new cloud server the system's own first-boot updates can hold the package lists for a while,
# so the list refresh is retried instead of failing at once.
apt_update() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if apt_get update; then return 0; fi
    printf 'Package lists are busy, trying again in 20 seconds (%s of 10).\n' "$i"
    sleep 20
  done
  die "Could not refresh the package lists. Run the installer again in a few minutes."
}

json_field() { # <key>: reads one top-level string field of a JSON document on stdin
  JSON_KEY=$1 "$NODE_BIN" -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c)).on("end", () => {
      const v = JSON.parse(d)[process.env.JSON_KEY];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    });'
}

cfg_get() { # <key>: one string field of the existing hub.json, empty when there is none
  if [ ! -f "$CONFIG_PATH" ]; then return 0; fi
  json_field "$1" <"$CONFIG_PATH" 2>/dev/null ||
    die "$CONFIG_PATH is not valid JSON. Fix it or move it away, then run the installer again."
}

check_system() {
  if [ "$(id -u)" -ne 0 ]; then die "Run this as root, for example: sudo bash $0"; fi
  local os_id os_ver machine
  os_id=$(. /etc/os-release && printf '%s' "${ID:-}")
  os_ver=$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")
  if [ "$os_id" != "ubuntu" ] || [ "$os_ver" != "24.04" ]; then
    die "This installer supports Ubuntu 24.04 only (this machine runs ${os_id:-unknown} ${os_ver:-})."
  fi
  machine=$(uname -m)
  case "$machine" in
    x86_64) NODE_ARCH=x64 NODE_SHA=$NODE_SHA256_X64 MTX_ARCH=amd64 MTX_SHA=$MEDIAMTX_SHA256_AMD64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 NODE_SHA=$NODE_SHA256_ARM64 MTX_ARCH=arm64 MTX_SHA=$MEDIAMTX_SHA256_ARM64 ;;
    *) die "Unsupported processor type $machine. Use an x86_64 or aarch64 (Ampere) machine." ;;
  esac
  command -v systemctl >/dev/null 2>&1 || die "systemd is required."
  if command -v ufw >/dev/null 2>&1 && [[ $(ufw status 2>/dev/null || true) == *"Status: active"* ]]; then
    die "The ufw firewall is turned on. This installer sets up the firewall itself. Turn ufw off with 'sudo ufw disable' and run the installer again."
  fi
}

install_packages() {
  say "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive
  # Ubuntu's "restart services?" check only lists what needs a restart, never stops to ask.
  export NEEDRESTART_MODE=l
  debconf-set-selections <<'EOF'
iptables-persistent iptables-persistent/autosave_v4 boolean false
iptables-persistent iptables-persistent/autosave_v6 boolean false
EOF
  apt_update
  apt_get install --no-install-recommends ca-certificates curl gnupg git rsync xz-utils ffmpeg \
    wireguard-tools iproute2 iptables iptables-persistent netfilter-persistent
}

# --from-git: downloads the code into the temporary folder; install_code then copies it (with its
# git history, so deploy/update.sh works later) to /opt/comffee-cctv as usual.
clone_from_git() {
  if [ -z "$GIT_URL" ]; then return 0; fi
  say "Downloading the code from $GIT_URL${GIT_REF:+ ($GIT_REF)}"
  local ref_args=()
  if [ -n "$GIT_REF" ]; then ref_args=(--branch "$GIT_REF"); fi
  GIT_TERMINAL_PROMPT=0 git -c protocol.allow=never -c protocol.https.allow=always -c advice.detachedHead=false \
    clone --quiet "${ref_args[@]}" -- "$GIT_URL" "$TMP/src" ||
    die "Could not download the code from $GIT_URL${GIT_REF:+ at $GIT_REF}. Check the address and the version name."
  printf 'Downloaded version %s\n' "$(git -C "$TMP/src" rev-parse --short HEAD)"
  REPO_DIR="$TMP/src"
}

install_node() {
  local name="node-$NODE_VERSION-linux-$NODE_ARCH"
  local dest="$RUNTIME_DIR/$name"
  install -d -m 0755 "$RUNTIME_DIR"
  if runtime_ok "$dest" bin/node "$NODE_SHA"; then
    say "Node.js $NODE_VERSION is installed and unchanged"
  else
    say "Downloading Node.js $NODE_VERSION"
    fetch "https://nodejs.org/dist/$NODE_VERSION/$name.tar.xz" "$TMP/$name.tar.xz"
    fetch "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" "$TMP/node-SHASUMS256.txt"
    verify_download "$TMP/$name.tar.xz" "$name.tar.xz" "$NODE_SHA" "$TMP/node-SHASUMS256.txt"
    unpack "$TMP/$name.tar.xz" "$dest" bin/node "$NODE_SHA" --strip-components=1
  fi
  ln -sfn "$name" "$RUNTIME_DIR/node"
}

install_mediamtx() {
  local name="mediamtx_${MEDIAMTX_VERSION}_linux_${MTX_ARCH}.tar.gz"
  local dest="$RUNTIME_DIR/mediamtx-$MEDIAMTX_VERSION"
  local base="https://github.com/bluenviron/mediamtx/releases/download/$MEDIAMTX_VERSION"
  if runtime_ok "$dest" mediamtx "$MTX_SHA"; then
    say "MediaMTX $MEDIAMTX_VERSION is installed and unchanged"
  else
    say "Downloading MediaMTX $MEDIAMTX_VERSION"
    fetch "$base/$name" "$TMP/$name"
    fetch "$base/checksums.sha256" "$TMP/mediamtx-checksums.sha256"
    verify_download "$TMP/$name" "$name" "$MTX_SHA" "$TMP/mediamtx-checksums.sha256"
    unpack "$TMP/$name" "$dest" mediamtx "$MTX_SHA"
    # The sample config in the archive is not used; ours is rendered into /etc/comffee-cctv.
    rm -f "$dest/mediamtx.yml"
  fi
  ln -sfn "mediamtx-$MEDIAMTX_VERSION" "$RUNTIME_DIR/mediamtx"
}

key_fingerprint() {
  local out
  out=$(GNUPGHOME="$TMP/gnupg" gpg --batch --show-keys --with-colons "$1" 2>/dev/null) || return 1
  awk -F: '$1 == "fpr" && !done { print $10; done = 1 }' <<<"$out"
}

install_caddy() {
  say "Installing Caddy from its official signed package repository"
  if [ "$(key_fingerprint "$CADDY_KEYRING" || true)" != "$CADDY_KEY_FINGERPRINT" ]; then
    fetch "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" "$TMP/caddy-key.asc"
    if [ "$(key_fingerprint "$TMP/caddy-key.asc" || true)" != "$CADDY_KEY_FINGERPRINT" ]; then
      die "The Caddy signing key did not match the expected fingerprint. Nothing was installed."
    fi
    GNUPGHOME="$TMP/gnupg" gpg --batch --dearmor <"$TMP/caddy-key.asc" >"$TMP/caddy-key.gpg"
    install -m 0644 "$TMP/caddy-key.gpg" "$CADDY_KEYRING"
  fi
  printf 'deb [signed-by=%s] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n' \
    "$CADDY_KEYRING" >"$CADDY_LIST"
  apt_update
  apt_get install caddy
}

resolve_settings() {
  local existing_host existing_ip existing_data
  existing_host=$(cfg_get publicHost)
  existing_ip=$(cfg_get publicIp)
  existing_data=$(cfg_get dataDir)

  REPO_DIR=${REPO_DIR:-$(dirname "$SCRIPT_DIR")}

  DATA_DIR=${DATA_DIR:-${existing_data:-$DEFAULT_DATA_DIR}}
  DATA_DIR=${DATA_DIR%/}
  valid_data_dir "$DATA_DIR" || die "--data-dir must be a plain absolute folder such as /var/lib/comffee-cctv."
  if [ -n "$existing_data" ] && [ "$existing_data" != "$DATA_DIR" ]; then
    warn "The data folder changes from $existing_data to $DATA_DIR. Existing recordings are not moved."
  fi

  if [ -z "$PUBLIC_IP" ]; then
    say "Finding this server's public IP address"
    PUBLIC_IP=$(detect_public_ip || true)
    PUBLIC_IP=${PUBLIC_IP:-$existing_ip}
  fi
  valid_ipv4 "$PUBLIC_IP" || die "Could not find this server's public IP address. Run again with --public-ip <address>."
  if [ -n "$existing_ip" ] && [ "$existing_ip" != "$PUBLIC_IP" ]; then
    warn "The public IP changed from $existing_ip to $PUBLIC_IP. Router locations need their router script pasted again."
  fi

  if [ -z "$HOST" ]; then
    if [ -n "$existing_host" ] && [[ $existing_host != *.sslip.io ]]; then
      HOST=$existing_host
    else
      HOST="${PUBLIC_IP//./-}.sslip.io"
    fi
  fi
  HOST=${HOST,,}
  HOST=${HOST%.}
  valid_host "$HOST" || die "--host must be a domain name such as cctv.example.com (got '$HOST')."
}

detect_public_ip() {
  local url ip
  for url in https://ifconfig.me https://api.ipify.org https://checkip.amazonaws.com; do
    ip=$(curl -4 -fsS -m 10 "$url" 2>/dev/null) || continue
    ip=${ip//[[:space:]]/}
    if valid_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  done
  return 1
}

create_user_and_dirs() {
  say "Creating the service account and folders"
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
  # The media server sees only this folder of the data folder (see its systemd unit), so it must
  # exist before the first start.
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/raw"
  install -d -m 0750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"
}

install_code() {
  local src app_real=""
  src=$(cd "$REPO_DIR" 2>/dev/null && pwd -P) || die "Folder $REPO_DIR does not exist."
  if [ ! -f "$src/package.json" ] || [ ! -f "$src/server/src/contracts.ts" ] || [ ! -f "$src/deploy/install.sh" ]; then
    die "$src does not look like the Comffee CCTV folder."
  fi
  if [ -d "$APP_DIR" ]; then app_real=$(cd "$APP_DIR" && pwd -P); fi
  if [ "$src" != "$app_real" ]; then
    say "Copying the code to $APP_DIR"
    install -d -m 0755 "$APP_DIR"
    rsync -a --delete --exclude=/node_modules/ --exclude=/dashboard/dist/ --exclude=/bridge/dist/ \
      --exclude=/desktop/dist/ --exclude=/desktop/release/ --exclude=/.cache/ "$src/" "$APP_DIR/"
  fi
  # The code belongs to root so the running services can read it but never change it.
  chown -R root:root "$APP_DIR"
  chmod -R u+rwX,go+rX,go-w "$APP_DIR"
}

build_dashboard() {
  say "Installing libraries and building the dashboard (this can take a few minutes)"
  (
    cd "$APP_DIR"
    export PATH="$RUNTIME_DIR/node/bin:$PATH"
    export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
    npm ci --ignore-scripts
    npm run build:dashboard
    npm prune --omit=dev --ignore-scripts
  )
  [ -f "$APP_DIR/dashboard/dist/index.html" ] || die "The dashboard build did not produce dashboard/dist/index.html."
  chmod -R u+rwX,go+rX,go-w "$APP_DIR/node_modules" "$APP_DIR/dashboard/dist"
}

setup_wireguard() {
  local conf="/etc/wireguard/$WG_IF.conf" priv
  install -d -m 0700 /etc/wireguard
  if [ -s "$conf" ]; then
    if ! grep -Fq "$WG_ADDRESS" "$conf"; then
      die "$conf already exists with a different setup. Comffee CCTV needs $WG_IF for itself."
    fi
  else
    say "Creating the hub WireGuard key"
    priv=$(wg genkey)
    (
      umask 077
      printf '[Interface]\n# Comffee CCTV hub tunnel. The hub adds router peers itself while it runs.\nAddress = %s\nListenPort = %s\nMTU = %s\nPrivateKey = %s\n' \
        "$WG_ADDRESS" "$WG_PORT" "$WG_MTU" "$priv" >"$conf"
    )
  fi
  chown root:root "$conf"
  chmod 0600 "$conf"
  priv=$(sed -n 's/^PrivateKey[[:space:]]*=[[:space:]]*//p' "$conf")
  WG_PUBKEY=$(printf '%s\n' "$priv" | wg pubkey) || die "Could not read the WireGuard key in $conf."
  priv=""
  systemctl enable "wg-quick@$WG_IF.service" >/dev/null 2>&1
  if ! systemctl is-active --quiet "wg-quick@$WG_IF.service"; then
    systemctl start "wg-quick@$WG_IF.service"
  fi
}

ssh_ports() {
  local ports="22" key value out
  out=$(sshd -T 2>/dev/null || true)
  while read -r key value; do
    if [ "$key" = "port" ] && [[ $value =~ ^[0-9]+$ ]] && [[ " $ports " != *" $value "* ]]; then
      ports="$ports $value"
    fi
  done <<<"$out"
  printf '%s' "$ports"
}

# Builds our own chain and jumps to it first from INPUT. Rebuilding never removes the
# "established" rule before the final drop exists, so open SSH sessions survive.
apply_chain() {
  local ipt=$1 icmp=$2 ports=$3 p
  if ! "$ipt" -w -N "$FW_CHAIN" 2>/dev/null; then "$ipt" -w -F "$FW_CHAIN"; fi
  "$ipt" -w -A "$FW_CHAIN" -i lo -j ACCEPT
  # Router tunnels: only replies to connections the hub opened itself.
  "$ipt" -w -A "$FW_CHAIN" -i "$WG_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  "$ipt" -w -A "$FW_CHAIN" -i "$WG_IF" -j DROP
  "$ipt" -w -A "$FW_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  "$ipt" -w -A "$FW_CHAIN" -p "$icmp" -j ACCEPT
  "$ipt" -w -A "$FW_CHAIN" -m conntrack --ctstate INVALID -j DROP
  for p in $ports; do
    "$ipt" -w -A "$FW_CHAIN" -p tcp --dport "$p" -j ACCEPT
  done
  "$ipt" -w -A "$FW_CHAIN" -p tcp -m multiport --dports 80,443 -j ACCEPT
  "$ipt" -w -A "$FW_CHAIN" -p udp --dport "$WG_PORT" -j ACCEPT
  "$ipt" -w -A "$FW_CHAIN" -p udp --dport "$WEBRTC_UDP_PORT" -j ACCEPT
  if [ "$ipt" = "ip6tables" ]; then
    "$ipt" -w -A "$FW_CHAIN" -p udp --sport 547 --dport 546 -j ACCEPT
  fi
  "$ipt" -w -A "$FW_CHAIN" -j DROP
  jump_first "$ipt"
}

# The jump to our chain must be the very first INPUT rule. Some cloud images (Oracle's Ubuntu
# among them) ship INPUT rules that end in a REJECT for everything else; a rule placed after that
# REJECT would never run, so our allow rules (web, WireGuard, live view) sit in front of it.
# Puts the jump at position 1 first, then removes any later copy, so there is never a moment
# without it.
jump_first() {
  local ipt=$1 n
  if [ "$("$ipt" -w -S INPUT | sed -n '2p')" != "-A INPUT -j $FW_CHAIN" ]; then
    "$ipt" -w -I INPUT 1 -j "$FW_CHAIN"
  fi
  for n in $("$ipt" -w -L INPUT -n --line-numbers | awk -v c="$FW_CHAIN" 'NR > 2 && $1 != 1 && $2 == c { print $1 }' | sort -rn); do
    "$ipt" -w -D INPUT "$n"
  done
}

setup_firewall() {
  say "Setting up the firewall"
  local ports
  ports=$(ssh_ports)
  apply_chain iptables icmp "$ports"
  if ip6tables -w -S INPUT >/dev/null 2>&1; then
    apply_chain ip6tables ipv6-icmp "$ports"
  fi
  netfilter-persistent save >/dev/null 2>&1 ||
    die "Could not save the firewall rules. Run 'sudo netfilter-persistent save' to see why."
}

write_config() {
  say "Writing $CONFIG_PATH"
  CFG_PATH=$CONFIG_PATH CFG_OUT="$TMP/hub.json" CFG_HOST=$HOST CFG_IP=$PUBLIC_IP CFG_DATA=$DATA_DIR \
    CFG_APP=$APP_DIR CFG_HUB_PORT=$HUB_PORT CFG_WG_IF=$WG_IF CFG_WG_PORT=$WG_PORT \
    CFG_WG_ADDR=$WG_ADDRESS CFG_WG_KEY=$WG_PUBKEY "$NODE_BIN" -e '
      const fs = process.getBuiltinModule("node:fs");
      const e = process.env;
      let old = {};
      if (fs.existsSync(e.CFG_PATH)) {
        try { old = JSON.parse(fs.readFileSync(e.CFG_PATH, "utf8")); }
        catch { console.error(e.CFG_PATH + " is not valid JSON."); process.exit(1); }
      }
      const cfg = {
        dataDir: e.CFG_DATA,
        listenHost: "127.0.0.1",
        listenPort: Number(e.CFG_HUB_PORT),
        publicOrigin: "https://" + e.CFG_HOST,
        publicHost: e.CFG_HOST,
        publicIp: e.CFG_IP,
        dashboardDir: e.CFG_APP + "/dashboard/dist",
        mediamtxApi: "http://127.0.0.1:9997",
        mediamtxRtsp: "rtsp://127.0.0.1:8554",
        mediamtxWebrtc: "http://127.0.0.1:8889",
        ffmpegPath: typeof old.ffmpegPath === "string" && old.ffmpegPath ? old.ffmpegPath : "/usr/bin/ffmpeg",
        ffprobePath: typeof old.ffprobePath === "string" && old.ffprobePath ? old.ffprobePath : "/usr/bin/ffprobe",
        wireguard: {
          enabled: true,
          interface: e.CFG_WG_IF,
          listenPort: Number(e.CFG_WG_PORT),
          hubAddress: e.CFG_WG_ADDR,
          publicKey: e.CFG_WG_KEY,
        },
        devInsecureCookies: false,
        // Where owners download the bridge program; set it to your release page (https) or keep null.
        bridgeDownloadUrl: typeof old.bridgeDownloadUrl === "string" && old.bridgeDownloadUrl ? old.bridgeDownloadUrl : null,
      };
      // Keep settings this installer does not manage.
      for (const [k, v] of Object.entries(old)) if (!(k in cfg)) cfg[k] = v;
      fs.writeFileSync(e.CFG_OUT, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o640 });'
  install -m 0640 -o root -g "$SERVICE_USER" "$TMP/hub.json" "$CONFIG_PATH"
}

write_mediamtx_config() {
  say "Writing $MEDIAMTX_CONFIG"
  render "$APP_DIR/deploy/mediamtx.yml.template" "$TMP/mediamtx.yml" "DATA_DIR=$DATA_DIR" "PUBLIC_IP=$PUBLIC_IP"
  install -m 0640 -o root -g "$SERVICE_USER" "$TMP/mediamtx.yml" "$MEDIAMTX_CONFIG"
}

install_units() {
  say "Installing the system services"
  local unit
  for unit in "${UNITS[@]}"; do
    render "$APP_DIR/deploy/systemd/$unit.service" "$TMP/$unit.service" \
      "APP_DIR=$APP_DIR" "DATA_DIR=$DATA_DIR" "CONFIG_PATH=$CONFIG_PATH" "NODE_BIN=$NODE_BIN" \
      "MEDIAMTX_BIN=$MEDIAMTX_BIN" "MEDIAMTX_CONFIG=$MEDIAMTX_CONFIG"
    install -m 0644 "$TMP/$unit.service" "/etc/systemd/system/$unit.service"
  done
  systemctl daemon-reload
  systemctl enable "${UNITS[@]/%/.service}" >/dev/null 2>&1
}

configure_caddy() {
  say "Setting up HTTPS for https://$HOST"
  if [ -f "$CADDYFILE" ] && [ ! -e "$CADDYFILE_BACKUP" ] && ! grep -q "Comffee CCTV" "$CADDYFILE"; then
    cp -p "$CADDYFILE" "$CADDYFILE_BACKUP"
  fi
  render "$APP_DIR/deploy/Caddyfile.template" "$TMP/Caddyfile" "HOST=$HOST"
  if ! XDG_DATA_HOME="$TMP/caddy-data" XDG_CONFIG_HOME="$TMP/caddy-config" \
    caddy validate --adapter caddyfile --config "$TMP/Caddyfile" >"$TMP/caddy-validate.log" 2>&1; then
    cat "$TMP/caddy-validate.log" >&2
    die "The Caddy configuration did not pass Caddy's own check (see above)."
  fi
  install -m 0644 "$TMP/Caddyfile" "$CADDYFILE"
  systemctl enable caddy.service >/dev/null 2>&1
  systemctl reload-or-restart caddy.service
}

start_services() {
  say "Starting Comffee CCTV"
  systemctl restart comffee-cctv-mediamtx.service
  systemctl restart comffee-cctv-hub.service
}

wait_for_hub() {
  local i status=""
  for i in $(seq 1 90); do
    if status=$(curl -fsS -m 3 "http://127.0.0.1:$HUB_PORT/api/setup/status" 2>/dev/null); then break; fi
    status=""
    sleep 1
  done
  if [ -z "$status" ]; then
    journalctl -u comffee-cctv-hub.service -n 40 --no-pager >&2 || true
    die "The hub did not start within 90 seconds. The log above shows why."
  fi
  if ! systemctl is-active --quiet comffee-cctv-mediamtx.service; then
    journalctl -u comffee-cctv-mediamtx.service -n 40 --no-pager >&2 || true
    die "The media server did not start. The log above shows why."
  fi
  NEEDS_SETUP=$(json_field needsSetup <<<"$status" || true)
}

# Runs the hub command line as the service account, for example: run_cli setup-code
run_cli() {
  # main.ts is the only entry point; it hands any command-line arguments to the CLI.
  (cd "$APP_DIR" && runuser -u "$SERVICE_USER" -- env TZ=UTC "COMFFEE_CCTV_CONFIG=$CONFIG_PATH" "$NODE_BIN" server/src/main.ts "$@")
}

# A code from --setup-code (the desktop app's unattended install) is registered before the services
# start, so the hub never runs without it. The command line opens the database itself as the service
# account and leaves it alone when an owner account already exists. A failure stops the install, so
# cloud-init logs it as failed.
register_setup_code() {
  [ -n "$SETUP_CODE" ] || return 0
  say "Registering the setup code"
  run_cli setup-code --code "$SETUP_CODE" ||
    die "Could not register the setup code (see above). Run: sudo bash $APP_DIR/deploy/install.sh --setup-code <code> again."
}

prune_old_runtimes() {
  local keep_node="node-$NODE_VERSION-linux-$NODE_ARCH" keep_mtx="mediamtx-$MEDIAMTX_VERSION"
  find "$RUNTIME_DIR" -mindepth 1 -maxdepth 1 -type d \( -name 'node-v*' ! -name "$keep_node" \) -exec rm -rf {} +
  find "$RUNTIME_DIR" -mindepth 1 -maxdepth 1 -type d \( -name 'mediamtx-v*' ! -name "$keep_mtx" \) -exec rm -rf {} +
}

print_summary() {
  printf '\n----------------------------------------------------------------\n'
  printf 'Comffee CCTV is running.\n\n'
  printf '  Dashboard: https://%s\n\n' "$HOST"
  if [ -n "$SETUP_CODE" ] && [ "$NEEDS_SETUP" != "false" ]; then
    # The code came with --setup-code (for example from the desktop app) and was registered before the
    # services started; it is never printed here.
    printf 'Open the dashboard and enter the setup code you were given (valid 30 days) to create\n'
    printf 'the owner account.\n\n'
  elif [ "$NEEDS_SETUP" = "true" ]; then
    printf 'One-time setup code (valid 24 hours). Open the dashboard and enter it to create\n'
    printf 'the owner account:\n\n'
    run_cli setup-code || warn "Could not create a setup code. Run: sudo bash $APP_DIR/deploy/install.sh again."
    printf '\n'
  elif [ "$NEEDS_SETUP" = "false" ]; then
    printf 'An owner account already exists. Sign in at the address above.\n\n'
  else
    printf 'To get a one-time setup code for the owner account, run:\n'
    printf '  cd %s && sudo runuser -u %s -- env COMFFEE_CCTV_CONFIG=%s %s server/src/main.ts setup-code\n\n' \
      "$APP_DIR" "$SERVICE_USER" "$CONFIG_PATH" "$NODE_BIN"
  fi
  printf 'The first visit can take a minute while the HTTPS certificate is issued.\n'
  printf 'If the page does not open, check that TCP 80 and 443 and UDP %s and %s are open\n' "$WG_PORT" "$WEBRTC_UDP_PORT"
  printf 'in your cloud firewall (Oracle: the VCN security list, see docs/ORACLE-SETUP.md).\n'
  printf '----------------------------------------------------------------\n'
}

main() {
  parse_args "$@"
  check_system
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  install -d -m 0700 "$TMP/gnupg"

  install_packages
  clone_from_git
  install_node
  resolve_settings
  install_caddy
  install_mediamtx
  create_user_and_dirs
  install_code
  build_dashboard
  setup_wireguard
  setup_firewall
  write_config
  register_setup_code
  write_mediamtx_config
  install_units
  configure_caddy
  start_services
  wait_for_hub
  prune_old_runtimes
  print_summary
}

# Run only when executed, not when sourced, so the helpers above can be tested on their own.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
