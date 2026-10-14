import { handleRequest } from "../core/http";
import { guildStub, missingConfiguration, type Env } from "./env";
export { GuildProtection } from "./guild";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, { ...env, guild: guildStub(env), assets: env.ASSETS, hosting: "cloudflare" });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (!missingConfiguration(env).length) await guildStub(env).watchdog();
  },
} satisfies ExportedHandler<Env>;
