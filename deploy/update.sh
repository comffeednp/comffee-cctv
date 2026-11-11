#!/usr/bin/env bash
# Updates Comffee CCTV on this server to the newest version.
#
# Pulls the new code into /opt/comffee-cctv, then runs the installer again. The installer
# re-checks the installed Node.js and MediaMTX against their pinned hashes (downloading and
# verifying new pinned versions when the update changed them), reinstalls the libraries from the
# lock file, rebuilds the dashboard and restarts the services. Settings, keys and recordings are kept.
#
# Usage:
#   sudo bash /opt/comffee-cctv/deploy/update.sh [--ref <tag or branch>] [installer options]

set -euo pipefail

readonly APP_DIR="/opt/comffee-cctv"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Updates Comffee CCTV to the newest version and restarts it.

  sudo bash /opt/comffee-cctv/deploy/update.sh [options]

Options:
  --ref <tag or branch>   Update to this release tag or branch instead of the newest code on
                          the current branch.
  -h, --help              Show this help.

Any other option (for example --host) is passed on to deploy/install.sh.
EOF
}

main() {
  local ref="" args=() target branch before after
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref)
        if [ $# -lt 2 ]; then die "--ref needs a value."; fi
        ref=$2
        shift 2
        ;;
      --ref=*) ref=${1#*=}; shift ;;
      -h | --help) usage; exit 0 ;;
      *) args+=("$1"); shift ;;
    esac
  done

  if [ "$(id -u)" -ne 0 ]; then die "Run this as root, for example: sudo bash $0"; fi
  if [ ! -d "$APP_DIR/.git" ]; then
    die "$APP_DIR is not a git checkout. Put the new version there by hand and run: sudo bash $APP_DIR/deploy/install.sh"
  fi

  # core.fileMode=false: a script made executable by hand (chmod +x) does not count as a local change.
  local git=(git -c "safe.directory=$APP_DIR" -c core.fileMode=false -C "$APP_DIR")
  if [ -n "$("${git[@]}" status --porcelain --untracked-files=no)" ]; then
    die "Files in $APP_DIR were changed by hand. Undo those changes (git -C $APP_DIR stash) and run the update again."
  fi

  before=$("${git[@]}" rev-parse --short HEAD)
  say "Fetching the newest version"
  "${git[@]}" fetch --tags --prune origin

  if [ -n "$ref" ]; then
    if "${git[@]}" rev-parse --verify --quiet "refs/remotes/origin/$ref" >/dev/null; then
      target="origin/$ref"
    elif "${git[@]}" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
      target=$ref
    else
      die "Version '$ref' was not found."
    fi
    "${git[@]}" checkout --quiet --detach "$target"
  else
    branch=$("${git[@]}" symbolic-ref --short -q HEAD || true)
    if [ -z "$branch" ]; then
      # A previous --ref left the checkout on a fixed version; go back to the main branch.
      "${git[@]}" remote set-head origin --auto >/dev/null 2>&1 || true
      branch=$("${git[@]}" symbolic-ref --short -q refs/remotes/origin/HEAD || true)
      branch=${branch#origin/}
      if [ -z "$branch" ]; then die "Could not find the main branch. Run again with --ref <branch>."; fi
      "${git[@]}" checkout --quiet "$branch"
    fi
    "${git[@]}" merge --ff-only --quiet "origin/$branch" ||
      die "The local branch cannot be fast-forwarded to origin/$branch."
  fi

  after=$("${git[@]}" rev-parse --short HEAD)
  if [ "$before" = "$after" ]; then
    say "Already on the newest code ($after). Checking the installation and restarting anyway."
  else
    say "Code updated from $before to $after"
  fi

  exec bash "$APP_DIR/deploy/install.sh" --repo-dir "$APP_DIR" "${args[@]}"
}

# The whole script is read before git replaces any file, because main runs last.
main "$@"
exit $?
