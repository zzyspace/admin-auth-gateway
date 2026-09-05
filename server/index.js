import fs from "node:fs";
import path from "node:path";
import { createAccountStore } from "./account-store.js";
import { loadConfig } from "./config.js";
import { createSessionDatabase } from "./database.js";
import { createApp } from "./app.js";

const config = loadConfig();
if (config.authMode === "unified" && !fs.existsSync(path.join(config.stateDir, "accounts.db"))) {
  throw new Error("Import unified accounts before enabling unified mode.");
}
const accounts = config.authMode === "unified" ? createAccountStore({ stateDir: config.stateDir }) : undefined;
const database = createSessionDatabase({ stateDir: config.stateDir });
const { app, sessions } = createApp({ config, database, accounts });

sessions.cleanup();
const cleanupTimer = setInterval(() => sessions.cleanup(), 60 * 60 * 1000);
cleanupTimer.unref();

const server = app.listen(config.port, config.host, () => {
  console.log(`admin-auth-gateway listening on http://${config.host}:${config.port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down admin-auth-gateway.`);
  server.close(() => {
    clearInterval(cleanupTimer);
    database.close();
    accounts?.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
