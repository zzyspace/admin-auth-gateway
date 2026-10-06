# Release hooks for comeover/scripts/deploy-release.sh (sourced as root on the server).
# Never modify /etc/*.env here: /etc/admin-auth-gateway.env holds server-only
# settings such as the WeChat AppSecret.
SERVICES=(admin-auth-gateway.service)
UNIT_FILES=(deploy/systemd/admin-auth-gateway.service)
HEALTH_URL=http://127.0.0.1:8790/health/auth
REQUIRED_PATHS=(/etc/invoice-submit.env /etc/wechat-claw.env)

release_prepare() {
  install_node_modules
  npm ls --omit=dev --depth=0 >/dev/null
}

release_test() {
  run_isolated node --test tests/*.test.js
}

release_verify() {
  expect_status http://127.0.0.1:8790/login 200
  expect_status http://127.0.0.1:8790/auth/api/session 401
}
