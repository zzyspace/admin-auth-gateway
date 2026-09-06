# Unified authentication rollout — 2026-09-06

Unified authentication and the account-management interface were enabled in
production on 2026-09-06.

Validation completed for login, application separation, account-management
permissions, scoped data access, existing public submission routes, and desktop
and mobile interfaces. Existing account permissions were preserved according to
the confirmed migration plan. Unrelated application services were not restarted.

This documentation-only update does not change runtime code. Detailed operational
records are retained separately in restricted storage.

## Permission-management clarification — 2026-09-06

The permission-management interface was updated to remove ambiguous scope
combinations. “All” controls now select every child option and show an
indeterminate state after one child is cleared. Expense scope is presented as a
store-by-channel matrix, with separate view, submission, and import scopes.

Role fields are explicitly labels. Permission templates populate concrete
permissions, linked permissions are enforced in both the browser and server,
and enabled grants with no usable entry permission or an empty active scope are
rejected. Each form previews its effective access before saving. Disabled app
grants retain their settings while clearly showing that they are inactive.

Account identity screens now show the immutable account ID and login name,
password resets and global account disabling require confirmation, and audit
entries record permission and scope deltas without password values.

Production verification covered all current accounts and grants using the
authorization database as the source of truth. Changes made through the account
management page after the original rollout were retained. The four updated
admin services passed their deployment tests and health checks; the WeChat bot
process was not restarted. Browser behavior and desktop/mobile layouts were
verified locally against the exact artifacts whose hashes were confirmed in
production.
