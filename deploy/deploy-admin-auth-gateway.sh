#!/usr/bin/env bash

set -euo pipefail

DEFAULT_SERVER="${ADMIN_AUTH_DEPLOY_SERVER:-root@139.196.140.215}"
SERVER="${1:-${DEFAULT_SERVER}}"
MODE="${2:-production}"
APP_DIR="/opt/admin-auth-gateway/current"
SERVICE_NAME="admin-auth-gateway.service"
SYSTEMD_UNIT_DIR="/etc/systemd/system"
HEALTHZ_URL="http://127.0.0.1:8790/health/auth"

SSH_OPTS=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=no
  -o ConnectTimeout=10
)

usage() {
  cat <<EOF
Usage:
  bash deploy/deploy-admin-auth-gateway.sh [server] [production|http-trial]

The checkout must already exist at ${APP_DIR}. This installs and restarts only
the gateway service. Shared Nginx configuration is managed by server-infra.

The explicit http-trial mode installs a temporary seven-day non-Secure Cookie
override at /etc/admin-auth-gateway.env. Production mode removes that override.
EOF
}

wait_for_health() {
  local attempt
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if curl --fail --silent --show-error "${HEALTHZ_URL}" >/dev/null 2>&1; then
      echo "[deploy] Gateway health check passed"
      return 0
    fi
    sleep 1
  done
  echo "[deploy] Gateway health check failed: ${HEALTHZ_URL}" >&2
  return 1
}

run_release() {
  set -euo pipefail
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Please run this script as root or with sudo on the server." >&2
    exit 1
  fi

  for cmd in curl git install node npm systemctl; do
    command -v "${cmd}" >/dev/null 2>&1 || {
      echo "Missing required command: ${cmd}" >&2
      exit 1
    }
  done
  for required in /etc/invoice-submit.env /etc/wechat-claw.env; do
    [[ -f "${required}" ]] || {
      echo "Missing credential environment file: ${required}" >&2
      exit 1
    }
  done
  [[ -d "${APP_DIR}/.git" ]] || {
    echo "Application checkout does not exist: ${APP_DIR}" >&2
    exit 1
  }

  echo "[deploy] Pulling latest code"
  GIT_TERMINAL_PROMPT=0 \
  GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10" \
    git -C "${APP_DIR}" pull --ff-only --progress origin main

  echo "[deploy] Installing production dependencies"
  npm --prefix "${APP_DIR}" ci --omit=dev

  echo "[deploy] Running tests"
  npm --prefix "${APP_DIR}" test

  echo "[deploy] Installing systemd unit"
  install -m 0644 "${APP_DIR}/deploy/systemd/admin-auth-gateway.service" \
    "${SYSTEMD_UNIT_DIR}/${SERVICE_NAME}"

  case "${MODE}" in
    production)
      if [[ -f /etc/admin-auth-gateway.env ]]; then
        mv /etc/admin-auth-gateway.env "/etc/admin-auth-gateway.env.disabled-$(date +%Y%m%d%H%M%S)"
      fi
      ;;
    http-trial)
      install -m 0600 "${APP_DIR}/deploy/systemd/admin-auth-gateway.http-trial.env" \
        /etc/admin-auth-gateway.env
      echo "[deploy] WARNING: temporary HTTP Cookie mode is enabled"
      ;;
    *)
      echo "Unsupported deployment mode: ${MODE}" >&2
      exit 1
      ;;
  esac

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null
  systemctl restart "${SERVICE_NAME}"
  if ! wait_for_health; then
    systemctl --no-pager --full status "${SERVICE_NAME}" || true
    journalctl -u "${SERVICE_NAME}" -n 100 --no-pager || true
    exit 1
  fi

  echo "[deploy] Shared Nginx entry is managed by server-infra"
  echo "[deploy] Gateway is running in ${MODE} mode."
}

case "${SERVER}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

if [[ "${SERVER}" == "local" || "${SERVER}" == "localhost" ]]; then
  run_release
else
  ssh "${SSH_OPTS[@]}" "${SERVER}" "$(declare -f wait_for_health); $(declare -f run_release); APP_DIR='${APP_DIR}'; SERVICE_NAME='${SERVICE_NAME}'; SYSTEMD_UNIT_DIR='${SYSTEMD_UNIT_DIR}'; HEALTHZ_URL='${HEALTHZ_URL}'; MODE='${MODE}'; run_release"
fi
