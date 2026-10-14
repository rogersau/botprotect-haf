import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "botprotect-docker-"));
const envFile = join(directory, "compose.env");
await writeFile(envFile, "");
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = `http://localhost:${port}`;
const environment = { ...process.env, PUBLIC_URL: origin, HTTP_PORT: String(port), DISCORD_BOT_TOKEN: "", DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "", DISCORD_GUILD_ID: "" };
const compose = ["compose", "--env-file", envFile, "-p", `botprotect-validation-${process.pid}`, "-f", "compose.yml"];

async function command(executable, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: environment, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
    let output = "";
    if (capture) child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${executable} exited with code ${code}`)));
  });
}
const docker = (args, capture = false) => command("docker", [...compose, ...args], capture);
const helper = (source) => docker(["run", "--rm", "--no-deps", "botprotect", "node", "--input-type=module", "-e", source], true);

try {
  await docker(["up", "-d", "--build", "--wait", "--wait-timeout", "120"]);
  assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), { status: "ok" });
  assert.match(await (await fetch(origin)).text(), /<title>BotProtect/);
  assert.equal((await (await fetch(`${origin}/api/session`)).json()).hosting, "docker");
  assert.equal((await fetch(`${origin}/api/dashboard`)).status, 503);
  if (process.argv.includes("--browser")) {
    environment.E2E_BASE_URL = origin;
    environment.E2E_RUNTIME = "docker";
    await command("npm", ["run", "test:e2e"]);
  }
  await docker(["stop", "botprotect"]);
  const id = await docker(["ps", "-a", "-q", "botprotect"], true);
  assert.equal(await command("docker", ["inspect", "--format", "{{.State.ExitCode}}", id], true), "0");
  await helper("import {DatabaseSync} from 'node:sqlite'; const db = new DatabaseSync('/app/data/guild.sqlite'); db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('containerPersistence', JSON.stringify({ok:true})); db.close();");
  await docker(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "120"]);
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  await docker(["stop", "botprotect"]);
  const persisted = await helper("import {DatabaseSync} from 'node:sqlite'; const db = new DatabaseSync('/app/data/guild.sqlite'); console.log(db.prepare('SELECT value FROM meta WHERE key = ?').get('containerPersistence').value); db.close();");
  assert.deepEqual(JSON.parse(persisted), { ok: true });
  Object.assign(environment, { PUBLIC_URL: "https://botprotect.example", DISCORD_BOT_TOKEN: "test-only", DISCORD_CLIENT_ID: "100000000000000001", DISCORD_CLIENT_SECRET: "test-only", DISCORD_GUILD_ID: "100000000000000002" });
  await docker(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "120"]);
  const login = await fetch(`${origin}/auth/login`, { redirect: "manual", headers: { "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http" } });
  assert.equal(new URL(login.headers.get("Location")).searchParams.get("redirect_uri"), "https://botprotect.example/auth/callback");
  assert.match(login.headers.get("Set-Cookie"), /; Secure/);
  assert.equal((await fetch(`${origin}/api/gateway/start`, { method: "POST", headers: { Origin: "https://attacker.example" } })).status, 403);
  console.log("Docker checks passed: health, assets, persistent volume, graceful stop, HTTPS OAuth, and origin enforcement.");
} finally {
  await docker(["down", "--volumes", "--remove-orphans"]).catch((error) => console.error(error.message));
  await rm(directory, { recursive: true, force: true });
}
