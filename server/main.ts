import { startServer } from "./app";
import { readConfig } from "./config";

try {
  const config = readConfig();
  const app = await startServer(config);
  console.log(JSON.stringify({ event: "server_started", port: config.port, publicUrl: config.publicUrl }));
  const shutdown = () => {
    const deadline = setTimeout(() => { console.error(JSON.stringify({ event: "shutdown_timed_out" })); process.exit(1); }, 25_000);
    deadline.unref();
    void app.close().then(() => { clearTimeout(deadline); }).catch(() => { console.error(JSON.stringify({ event: "shutdown_failed" })); process.exitCode = 1; });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} catch (error) {
  console.error(JSON.stringify({ event: "startup_failed", message: error instanceof Error ? error.message : "Could not start the application." }));
  process.exitCode = 1;
}
