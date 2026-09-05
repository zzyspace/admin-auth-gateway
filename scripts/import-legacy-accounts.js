import fs from "node:fs";
import { loadConfig } from "../server/config.js";
import { createAccountStore, AccountStoreError } from "../server/account-store.js";
import { planLegacyAccountImport } from "../server/legacy-account-import.js";

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--mapping" && argv[index + 1] && !options.mapping) options.mapping = argv[++index];
    else if (arg === "--help") options.help = true;
    else throw new AccountStoreError("invalid-arguments");
  }
  return options;
}

let store;
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write("Usage: npm run accounts:preview -- [--mapping /private/path/mapping.json] [--apply]\nDefault: preview only; creates no database. --apply bootstraps an empty accounts.db.\n");
  } else {
    // Reuse the exact legacy normalization rules, including the invoice/expense
    // whitespace difference. Do not echo config-parser errors containing input.
    const config = loadConfig({ ...process.env, ADMIN_AUTH_MODE: "legacy" });
    const mapping = options.mapping ? JSON.parse(fs.readFileSync(options.mapping, "utf8")) : undefined;
    const plan = planLegacyAccountImport(config, mapping);
    if (options.apply) {
      if (!plan.preview.ready) throw new AccountStoreError("resolve-import-conflicts-first");
      store = createAccountStore({ stateDir: config.stateDir });
      const result = plan.apply(store);
      process.stdout.write(`${JSON.stringify({ success: true, ...result, loginMode: "legacy-unchanged" }, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(plan.preview, null, 2)}\n`);
      if (!plan.preview.ready) process.exitCode = 2;
    }
  }
} catch (error) {
  // SQLite, JSON and legacy config errors can contain supplied values. Keep the
  // CLI error contract finite and free of passwords or raw environment content.
  process.stderr.write(`${JSON.stringify({ success: false, error: error instanceof AccountStoreError ? error.code : "import-input-or-storage-error" })}\n`);
  process.exitCode = 1;
} finally {
  store?.close();
}
