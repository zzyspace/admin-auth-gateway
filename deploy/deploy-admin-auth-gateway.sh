#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo 'Usage: bash deploy/deploy-admin-auth-gateway.sh <full-40-character-commit-SHA> [root@server]'
  echo 'Deploys an exact, verified Git bundle into a new release, tests it, and switches with rollback.'
  echo 'Never modifies /etc/*.env: /etc/admin-auth-gateway.env holds server-only settings such as the WeChat AppSecret.'
  echo 'Shared Nginx configuration is managed by server-infra.'
}
if [[ "${1:-}" = --help || "${1:-}" = -h ]]; then usage; exit 0; fi
remote=0
if [[ "${1:-}" = --on-server ]]; then remote=1; shift; fi
expected=${1:-}
[[ "$expected" =~ ^[0-9a-f]{40}$ ]] || { usage >&2; exit 2; }
if [[ "$remote" = 0 ]]; then
  [[ $# -le 2 ]] || { usage >&2; exit 2; }
  destination=${2:-${ADMIN_AUTH_DEPLOY_SERVER:-root@139.196.140.215}}
  [[ "$destination" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$ ]] || exit 2
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  # In the comeover monorepo, $expected is the published mirror commit from scripts/publish-mirrors.mjs;
  # it must carry exactly the admin-auth-gateway tree checked out here.
  git -C "$root" cat-file -e "$expected^{commit}"
  [[ "$(git -C "$root" rev-parse "$expected^{tree}")" = "$(git -C "$root" rev-parse HEAD:./)" ]] || { echo 'Commit is not the published admin-auth-gateway tree at HEAD.' >&2; exit 1; }
  [[ -z "$(git -C "$root" status --porcelain --untracked-files=no -- .)" ]] || { echo 'Commit tracked changes first.' >&2; exit 1; }
  temp=$(mktemp -d)
  trap 'rm -rf "$temp"' EXIT
  # Bundle only admin-auth-gateway history, never the surrounding monorepo.
  git init -q --bare "$temp/source.git"
  git -C "$root" push -q "$temp/source.git" "$expected:refs/heads/release"
  git -C "$temp/source.git" symbolic-ref HEAD refs/heads/release
  git -C "$temp/source.git" bundle create -q "$temp/release.bundle" HEAD
  git -C "$temp/source.git" bundle verify -q "$temp/release.bundle"
  ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10)
  remote_dir=$(ssh "${ssh_opts[@]}" "$destination" 'mktemp -d /var/tmp/admin-auth-gateway-deploy.XXXXXX')
  [[ "$remote_dir" =~ ^/var/tmp/admin-auth-gateway-deploy\.[A-Za-z0-9]+$ ]]
  scp -q "${ssh_opts[@]}" "$temp/release.bundle" "$destination:$remote_dir/release.bundle"
  status=0
  ssh "${ssh_opts[@]}" "$destination" \
    "bash -s -- --on-server $expected $remote_dir/release.bundle" < "$root/deploy/deploy-admin-auth-gateway.sh" || status=$?
  ssh "${ssh_opts[@]}" "$destination" "rm -f $remote_dir/release.bundle; rmdir $remote_dir"
  exit "$status"
fi
[[ "$EUID" = 0 && $# = 2 ]] || exit 2
bundle=$2
[[ "$bundle" =~ ^/var/tmp/admin-auth-gateway-deploy\.[A-Za-z0-9]+/release\.bundle$ && -f "$bundle" ]] || exit 2
for command in git node npm curl systemctl runuser flock install; do command -v "$command" >/dev/null; done
for required in /etc/invoice-submit.env /etc/wechat-claw.env; do
  [[ -f "$required" ]] || { echo "Missing credential environment file: $required" >&2; exit 1; }
done
app_root=/opt/admin-auth-gateway
service=admin-auth-gateway.service
install -d -m 755 "$app_root/releases"
exec 9>"$app_root/.deploy.lock"
flock -n 9 || { echo 'Another gateway deployment is running.' >&2; exit 1; }
[[ -L "$app_root/current" ]] || { echo 'Current must be a symlink to a release.' >&2; exit 1; }
previous=$(readlink -f "$app_root/current")
systemctl is-active --quiet "$service"
printf 'PREVIOUS_RELEASE=%s\nPREVIOUS_SHA=%s\n' "$previous" "$(git -C "$previous" rev-parse HEAD 2>/dev/null || echo unknown)"
release="$app_root/releases/$expected"
if [[ ! -e "$release" ]]; then
  umask 022
  candidate=$(mktemp -d "$app_root/releases/.prepare-$expected-XXXXXX")
  git init -q "$candidate"
  git -C "$candidate" bundle verify -q "$bundle"
  git -C "$candidate" fetch -q --no-tags "$bundle" HEAD
  [[ "$(git -C "$candidate" rev-parse FETCH_HEAD)" = "$expected" ]]
  git -C "$candidate" checkout -q --detach "$expected"
  git -C "$candidate" remote add origin https://github.com/zzyspace/admin-auth-gateway.git
  cd "$candidate"
  if cmp -s "$previous/package-lock.json" package-lock.json && [[ -d "$previous/node_modules" ]]; then
    cp -a "$previous/node_modules" node_modules
  else
    npm ci --omit=dev --no-audit --no-fund
  fi
  npm ls --omit=dev --depth=0 >/dev/null
  chmod -R a+rX "$candidate"
  # No test process can read production env or state directories.
  runuser -u nobody -- env -i PATH=/usr/bin:/bin HOME=/tmp node --test tests/*.test.js
  mv "$candidate" "$release"
fi
[[ "$(git -C "$release" rev-parse HEAD)" = "$expected" && -z "$(git -C "$release" status --porcelain)" ]]
backup="/var/backups/admin-auth-gateway/$(date -u +%Y%m%dT%H%M%SZ)-${expected:0:7}"
install -d -m 700 "$backup"
cp "/etc/systemd/system/$service" "$backup/$service"
wait_for_health() {
  for ((attempt=1;attempt<=30;attempt++)); do
    if curl --max-time 2 -fsS http://127.0.0.1:8790/health/auth >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
switched=0
rollback() {
  code=$?
  trap - ERR
  if [[ "$switched" = 1 ]]; then
    echo "Rolling back to $previous" >&2
    ln -s "$previous" "$app_root/.rollback-$$"; mv -Tf "$app_root/.rollback-$$" "$app_root/current"
    install -m 644 "$backup/$service" "/etc/systemd/system/$service"
    systemctl daemon-reload; systemctl restart "$service"
    if wait_for_health; then echo 'Rollback is healthy.' >&2; fi
  fi
  exit "$code"
}
trap rollback ERR
install -m 644 "$release/deploy/systemd/$service" "/etc/systemd/system/$service"
ln -s "$release" "$app_root/.current-$$"; mv -Tf "$app_root/.current-$$" "$app_root/current"
switched=1
systemctl daemon-reload
systemctl enable "$service" >/dev/null
systemctl restart "$service"
wait_for_health
systemctl is-active --quiet "$service"
expect_status() { [[ "$(curl --max-time 5 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8790$1")" = "$2" ]] || { echo "Unexpected status for $1" >&2; return 1; }; }
expect_status /login 200
expect_status /auth/api/session 401
echo 'Loopback health, login page and unauthenticated session check verified.'
printf 'DEPLOYED_SHA=%s\nBACKUP=%s\n' "$expected" "$backup"
systemctl show "$service" -p ActiveState -p SubState -p MainPID
