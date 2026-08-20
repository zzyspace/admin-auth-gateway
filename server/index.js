import { loadConfig } from "./config.js";
import { createSessionDatabase } from "./database.js";
import { createApp } from "./app.js";

const config = loadConfig();
const database = createSessionDatabase({ stateDir: config.stateDir });
const { app, sessions } = createApp({ config, database });

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
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
