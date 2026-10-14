import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AppSession, Dashboard, Flag, GatewayStatus, GuildResources, Settings } from "../shared/types";

type ServerData = {
  session: AppSession | null;
  dashboard: Dashboard | null;
  resources: GuildResources | null;
  draft: Settings | null;
};
type Notice = { error?: boolean; text: string };

const emptyData: ServerData = { session: null, dashboard: null, resources: null, draft: null };
const credentials = ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_GUILD_ID"];
const repository = "https://github.com/rogersau/botprotect-haf";

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin", ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error : "The request failed. Please try again.";
    throw new ApiError(message, response.status);
  }
  if (body === null) throw new Error("The server returned an unreadable response. Please try again.");
  return body as T;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : "The request failed. Please try again.";
const unauthorized = (error: unknown) => error instanceof ApiError && error.status === 401;
const running = (status: GatewayStatus["status"]) => ["ready", "connecting", "reconnecting"].includes(status);

export function App() {
  const [data, setData] = useState<ServerData>(emptyData);
  const [loading, setLoading] = useState<"session" | "dashboard" | null>("session");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const actionRunning = useRef(false);
  const revision = useRef(0);

  const expireSession = useCallback(() => {
    controllerRef.current?.abort();
    revision.current += 1;
    actionRunning.current = false;
    setBusy(false);
    setLoading(null);
    setData((current) => ({
      ...emptyData,
      session: current.session ? { ...current.session, authenticated: false, user: undefined } : null,
    }));
    setNotice({ error: true, text: "Your Discord session expired. Sign in again to manage this server." });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    let timer: number | undefined;
    setData(emptyData);
    setLoading("session");
    setLoadError(null);
    setResourcesError(null);
    setNotice(null);

    async function poll() {
      if (controller.signal.aborted) return;
      if (!actionRunning.current) {
        const startedAt = revision.current;
        try {
          const dashboard = await api<Dashboard>("/api/dashboard", { signal: controller.signal });
          if (!controller.signal.aborted && startedAt === revision.current) {
            setData((current) => ({ ...current, dashboard }));
            setLoadError(null);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          if (unauthorized(error)) expireSession();
          else if (startedAt === revision.current) setLoadError(errorText(error));
        }
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 15_000);
    }

    async function load() {
      try {
        const session = await api<AppSession>("/api/session", { signal: controller.signal });
        if (controller.signal.aborted) return;
        setData({ ...emptyData, session });
        const query = new URLSearchParams(window.location.search);
        const authError = query.get("auth_error");
        if (authError) {
          setNotice({ error: true, text: authError });
          query.delete("auth_error");
          window.history.replaceState(null, "", window.location.pathname + (query.size ? "?" + query : ""));
        }
        if (!session.configured || !session.authenticated) return;
        setLoading("dashboard");
        const startedAt = revision.current;
        const results = await Promise.allSettled([
          api<Dashboard>("/api/dashboard", { signal: controller.signal }),
          api<GuildResources>("/api/resources", { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        const [dashboardResult, resourcesResult] = results;
        if (results.some((result) => result.status === "rejected" && unauthorized(result.reason))) {
          expireSession();
          return;
        }
        if (dashboardResult.status === "fulfilled") {
          if (startedAt === revision.current) setData((current) => ({ ...current, dashboard: dashboardResult.value }));
        } else setLoadError(errorText(dashboardResult.reason));
        if (resourcesResult.status === "fulfilled") {
          setData((current) => ({ ...current, resources: resourcesResult.value }));
        } else setResourcesError(errorText(resourcesResult.reason));
        timer = window.setTimeout(poll, 15_000);
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(errorText(error));
      } finally {
        if (!controller.signal.aborted) setLoading(null);
      }
    }
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [attempt, expireSession]);

  // One action at a time; an older poll cannot replace its result or an unsaved draft.
  async function runAction<T>(request: (signal: AbortSignal) => Promise<T>, accept: (result: T) => void, text: string) {
    const controller = controllerRef.current;
    if (!controller || controller.signal.aborted || actionRunning.current) return;
    actionRunning.current = true;
    revision.current += 1;
    setBusy(true);
    setNotice(null);
    try {
      const result = await request(controller.signal);
      if (controller.signal.aborted) return;
      accept(result);
      setNotice({ text });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (unauthorized(error)) expireSession();
      else setNotice({ error: true, text: errorText(error) });
    } finally {
      if (!controller.signal.aborted) {
        revision.current += 1;
        actionRunning.current = false;
        setBusy(false);
      }
    }
  }

  const settings = data.draft ?? data.dashboard?.settings;
  const authenticated = data.session?.configured && data.session.authenticated;
  const dirty = data.draft !== null;
  const enabled = data.dashboard?.settings.honeypotEnabled || data.dashboard?.settings.spamEnabled;
  const channels = data.resources?.channels.filter((channel) => [0, 5].includes(channel.type));
  const channelName = (id: string) => data.resources?.channels.find((channel) => channel.id === id)?.name ?? id;
  const openFlags = data.dashboard?.flags.filter((flag) => flag.status === "open") ?? [];
  const reviewedFlags = data.dashboard?.flags.filter((flag) => flag.status !== "open").sort((a, b) => b.createdAt - a.createdAt) ?? [];

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    setData((current) => {
      const previous = current.draft ?? current.dashboard?.settings;
      return previous ? { ...current, draft: { ...previous, [key]: value } } : current;
    });
  }

  function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!settings || !dirty || !data.resources || resourcesError) return;
    if (settings.honeypotEnabled && !settings.honeypotChannelIds.length) {
      setNotice({ error: true, text: "Choose a honeypot channel before enabling it." });
      return;
    }
    void runAction(
      (signal) => api<{ settings: Settings }>("/api/settings", { method: "PUT", body: JSON.stringify(settings), signal }),
      ({ settings: saved }) => setData((current) => current.dashboard ? { ...current, draft: null, dashboard: { ...current.dashboard, settings: saved } } : current),
      "Protection settings saved.",
    );
  }

  function toggleProtection() {
    if (!data.dashboard) return;
    const stop = running(data.dashboard.gateway.status);
    void runAction(
      (signal) => api<GatewayStatus>("/api/gateway/" + (stop ? "stop" : "start"), { method: "POST", signal }),
      (gateway) => setData((current) => current.dashboard ? { ...current, dashboard: { ...current.dashboard, gateway } } : current),
      stop ? "Protection paused." : "Protection start requested.",
    );
  }

  function reviewFlag(flag: Flag, status: "confirmed" | "dismissed") {
    void runAction(
      (signal) => api("/api/flags/" + flag.id, { method: "PATCH", body: JSON.stringify({ status }), signal }),
      () => setData((current) => current.dashboard ? {
        ...current, dashboard: { ...current.dashboard, flags: current.dashboard.flags.map((item) => item.id === flag.id
          ? { ...item, status, resolvedBy: current.session?.user?.id ?? null, resolvedAt: Date.now() } : item) },
      } : current),
      status === "confirmed" ? "Flag confirmed. No account action was taken." : "Flag dismissed.",
    );
  }

  function refreshDashboard() {
    void runAction(
      (signal) => api<Dashboard>("/api/dashboard", { signal }),
      (dashboard) => { setData((current) => ({ ...current, dashboard })); setLoadError(null); },
      "Protection data refreshed.",
    );
  }

  function checkConnection(checkBot: boolean) {
    void runAction(async (signal) => {
      if (checkBot) await api("/api/setup/check", { signal });
      return api<GuildResources>("/api/resources", { signal });
    }, (resources) => {
      setData((current) => ({ ...current, resources }));
      setResourcesError(null);
    }, checkBot ? "Bot credentials and server access verified. Check channel permissions and Message Content Intent in Discord." : "Discord channels and roles loaded.");
  }

  function retryJobs() {
    void runAction(async (signal) => {
      await api("/api/jobs/retry", { method: "POST", signal });
      return api<Dashboard>("/api/dashboard", { signal });
    }, (dashboard) => setData((current) => ({ ...current, dashboard })), "Failed message actions queued for another attempt.");
  }

  function signOut() {
    void runAction(
      (signal) => api("/auth/logout", { method: "POST", signal }),
      () => { controllerRef.current?.abort(); setData((current) => ({ ...emptyData, session: current.session ? { ...current.session, authenticated: false } : null })); window.location.reload(); },
      "Signed out.",
    );
  }

  return <>
    <header className="topbar"><div className="topbar-inner">
      <a className="wordmark" href="https://hafbot.xyz" target="_blank" rel="noreferrer"><img src="/icon.svg" width="28" height="28" alt="" />HAFBOT <span>/ BotProtect</span></a>
      {authenticated && <div className="account"><span>{data.session?.user?.username}</span><button type="button" onClick={signOut} disabled={busy}>Sign out</button></div>}
    </div></header>
    <main>
      <div className="page-heading"><div><p className="eyebrow">Discord server protection</p><h1>BotProtect</h1></div>{data.resources && <p className="guild-name">{data.resources.guild.name}</p>}</div>
      <p className="intro">Catch honeypot posts and repeated messages across channels.</p>
      {notice && <div className={"notice" + (notice.error ? " error" : "")} role={notice.error ? "alert" : "status"}>
        <p>{notice.text}</p><button type="button" onClick={() => setNotice(null)}>Dismiss</button>
      </div>}
      {loading && <p className="panel muted" role="status">{loading === "session" ? "Checking Discord configuration…" : "Loading server protection…"}</p>}
      {!data.session && loadError && <section className="panel"><h2>Could not load BotProtect</h2><p className="error-copy" role="alert">{loadError}</p><button type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></section>}

      {data.session && !data.session.configured && <section className="panel"><h2>Finish Discord setup</h2><p>Add the four Discord credentials listed in Setup, then reload this page to sign in.</p></section>}
      {data.session?.configured && !authenticated && <section className="panel access">
        <h2>Sign in to manage protection</h2><p>Use a Discord account that owns this server or has Manage Server or Administrator permission.</p>
        <a className="button primary" href="/auth/login">Sign in with Discord</a>
      </section>}

      {authenticated && !loading && loadError && <div className="notice error" role="alert"><p>{data.dashboard ? "Live refresh failed: " : ""}{loadError}</p><button type="button" onClick={refreshDashboard} disabled={busy}>Retry</button></div>}

      {authenticated && data.dashboard && settings && <>
        <section className="panel protection" aria-labelledby="protection-title">
          <div><p className="eyebrow">Status</p><h2 id="protection-title">{gatewayLabel(data.dashboard.gateway.status)}</h2>
            <p>{dirty ? "Save your changes to apply them to protection." : !enabled ? "Enable at least one detector below and save your settings." : data.dashboard.gateway.status === "ready" ? "Watching the detectors you enabled below." : running(data.dashboard.gateway.status) ? "Connecting to Discord. Status refreshes automatically." : "Start protection after checking your settings and channel permissions."}</p>
          </div>
          <button className="primary" type="button" onClick={toggleProtection} disabled={busy || (!running(data.dashboard.gateway.status) && (dirty || !enabled))}>{running(data.dashboard.gateway.status) ? "Pause protection" : "Start protection"}</button>
        </section>
        {data.dashboard.gateway.error && <p className="notice error" role="alert">{data.dashboard.gateway.error}</p>}
        {data.dashboard.jobsPending > 0 && <p className="notice">{data.dashboard.jobsPending} message action(s) pending.</p>}
        {data.dashboard.jobsFailed > 0 && <div className="notice error"><p>{data.dashboard.jobsFailed} message action(s) failed.</p><button type="button" onClick={retryJobs} disabled={busy}>Retry failed actions</button></div>}

        <section className="panel" aria-labelledby="settings-title">
          <div className="section-heading"><h2 id="settings-title">Protection settings</h2>{dirty && <span className="muted">Unsaved changes</span>}</div>
          {resourcesError && <div className="notice error" role="alert"><p>{resourcesError} Load Discord channels and roles before saving settings.</p><button type="button" onClick={() => checkConnection(false)} disabled={busy}>Retry connection</button></div>}
          <form onSubmit={saveSettings}>
            <div className="settings-grid">
              <fieldset disabled={busy}>
                <legend>Honeypot</legend>
                <label className="check"><input type="checkbox" checked={settings.honeypotEnabled} onChange={(event) => updateSetting("honeypotEnabled", event.currentTarget.checked)} />Enable honeypot</label>
                <MultiSelect id="honeypot-channels" label="Honeypot channels" options={channels?.map((channel) => ({ id: channel.id, name: "# " + channel.name }))} values={settings.honeypotChannelIds} onChange={(values) => updateSetting("honeypotChannelIds", values)} />
                <p className="hint">Clearly mark trap channels as off limits. Keep them visible and writable for the members you want to monitor.</p>
                <label className="check"><input type="checkbox" checked={settings.honeypotDelete} onChange={(event) => updateSetting("honeypotDelete", event.currentTarget.checked)} />Delete honeypot messages</label>
              </fieldset>
              <fieldset disabled={busy}>
                <legend>Cross-channel spam</legend>
                <label className="check"><input type="checkbox" checked={settings.spamEnabled} onChange={(event) => updateSetting("spamEnabled", event.currentTarget.checked)} />Enable cross-channel spam</label>
                <p className="hint">Flag a member repeating the same message across different channels.</p>
                <div className="number-fields">
                  <div><label htmlFor="spam-threshold">Different channels</label><input id="spam-threshold" type="number" required min="2" max="20" value={settings.spamThreshold} onChange={(event) => updateSetting("spamThreshold", Number(event.currentTarget.value))} /></div>
                  <div><label htmlFor="spam-window">Time window (seconds)</label><input id="spam-window" type="number" required min="5" max="300" value={settings.spamWindowSeconds} onChange={(event) => updateSetting("spamWindowSeconds", Number(event.currentTarget.value))} /></div>
                </div>
                <label className="check"><input type="checkbox" checked={settings.spamDelete} onChange={(event) => updateSetting("spamDelete", event.currentTarget.checked)} />Delete spam messages</label>
              </fieldset>
              <fieldset disabled={busy} className="team-settings">
                <legend>Team</legend>
                <MultiSelect id="trusted-roles" label="Trusted roles" options={data.resources?.roles.filter((role) => role.id !== data.resources?.guild.id)} values={settings.excludedRoleIds} onChange={(values) => updateSetting("excludedRoleIds", values)} />
                <p className="hint">Members with these roles bypass both detectors. Bots and webhooks are always ignored.</p>
              </fieldset>
              <fieldset disabled={busy} className="team-settings">
                <legend>Notifications</legend>
                <label htmlFor="review-channel">Staff review channel</label>
                <select id="review-channel" value={settings.reviewChannelId ?? ""} disabled={!data.resources} onChange={(event) => updateSetting("reviewChannelId", event.currentTarget.value || null)}>
                  <option value="">Dashboard only</option>
                  {settings.reviewChannelId && !channels?.some((channel) => channel.id === settings.reviewChannelId) && <option value={settings.reviewChannelId}>{settings.reviewChannelId} (unavailable)</option>}
                  {channels?.map((channel) => <option key={channel.id} value={channel.id}># {channel.name}</option>)}
                </select>
                <p className="hint">Optionally send new flags to a private staff channel.</p>
              </fieldset>
            </div>
            <div className="form-actions"><p className="hint">Deletion is optional. Account decisions stay with your moderators.</p><div className="actions">
              {dirty && <button type="button" disabled={busy} onClick={() => setData((current) => ({ ...current, draft: null }))}>Discard changes</button>}
              <button className="primary" type="submit" disabled={busy || !dirty || !data.resources || !!resourcesError}>Save settings</button>
            </div></div>
          </form>
        </section>

        <section className="panel" aria-labelledby="review-title">
          <div className="section-heading"><h2 id="review-title">Review queue</h2><span className="muted">{openFlags.length} open</span></div>
          <p className="hint review-hint">Confirming records a decision. BotProtect never bans, kicks, times out, or changes member roles.</p>
          <div className="review-list">
            {openFlags.map((flag) => <FlagCard key={flag.id} flag={flag} guildId={data.session?.guildId} channelName={channelName} busy={busy} onReview={reviewFlag} />)}
            {!openFlags.length && <p className="empty-queue">No flags are waiting for review.</p>}
          </div>
          {!!reviewedFlags.length && <details className="history"><summary>Recently reviewed ({reviewedFlags.length})</summary><div className="review-list">
            {reviewedFlags.map((flag) => <FlagCard key={flag.id} flag={flag} guildId={data.session?.guildId} channelName={channelName} busy={busy} />)}
          </div></details>}
        </section>
      </>}

      {data.session && <details className="panel setup" open={!data.session.configured}>
        <summary>Setup</summary>
        <div className="setup-grid">
          <div><h3>Discord credentials</h3><ul className="credential-list">{credentials.map((name) => <li key={name}><code>{name}</code><span>{data.session?.missing.includes(name) ? "Missing" : "Configured"}</span></li>)}</ul></div>
          <div><h3>Discord access</h3><p>Add this exact OAuth2 redirect URL:</p><code className="callback">{window.location.origin}/auth/callback</code>
            <p>Enable <strong>Message Content Intent</strong>. Invite the bot with View Channels, Send Messages, and Embed Links. Add Manage Messages if you enable deletion. Grant access to the channels it watches and your staff review channel.</p>
            {data.session.inviteUrl && <a className="inline-link" href={data.session.inviteUrl} target="_blank" rel="noreferrer">Invite the bot</a>}
            {authenticated && <button type="button" disabled={busy || loading !== null} onClick={() => checkConnection(true)}>Check connection</button>}
          </div>
        </div>
        <p className="setup-links"><a href={repository + "#readme"} target="_blank" rel="noreferrer">Setup instructions</a><a href={repository + "/blob/main/docs/technical.md"} target="_blank" rel="noreferrer">Technical guide</a><a href={repository + "/blob/main/docs/docker.md"} target="_blank" rel="noreferrer">Docker guide</a></p>
      </details>}
      <footer>BotProtect by <a href="https://hafbot.xyz" target="_blank" rel="noreferrer">HAFBOT</a><a href={repository} target="_blank" rel="noreferrer">GitHub</a></footer>
    </main>
  </>;
}

function MultiSelect({ id, label, options, values, onChange }: {
  id: string; label: string; options?: { id: string; name: string }[];
  values: string[]; onChange: (values: string[]) => void;
}) {
  return <div className="selection">
    <label htmlFor={id}>{label}</label>
    <select id={id} value="" disabled={!options} onChange={(event) => { if (event.currentTarget.value) onChange([...values, event.currentTarget.value]); }}>
      <option value="">{options ? "Choose…" : "Channels and roles unavailable"}</option>
      {options?.filter((option) => !values.includes(option.id)).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select>
    {!!values.length && <ul className="selected-values">{values.map((value) => {
      const name = options?.find((option) => option.id === value)?.name ?? value;
      return <li key={value}><span>{name}</span><button type="button" aria-label={"Remove " + name} onClick={() => onChange(values.filter((id) => id !== value))}>Remove</button></li>;
    })}</ul>}
  </div>;
}

function FlagCard({ flag, guildId, channelName, busy, onReview }: {
  flag: Flag; guildId?: string; channelName: (id: string) => string; busy: boolean;
  onReview?: (flag: Flag, status: "confirmed" | "dismissed") => void;
}) {
  return <article className="flag-card">
    <div className="flag-heading"><div><p className="eyebrow">{flag.detector === "honeypot" ? "Honeypot" : "Cross-channel spam"}</p><h3>{flag.username}</h3></div><span className="flag-status">{flag.status === "open" ? "Needs review" : flag.status === "confirmed" ? "Confirmed" : "Dismissed"}</span></div>
    <p className="hint">#{channelName(flag.channelId)} · <time dateTime={new Date(flag.createdAt).toISOString()}>{new Date(flag.createdAt).toLocaleString()}</time></p>
    <blockquote>{flag.preview || "No text preview was recorded."}</blockquote>
    <p className="evidence">{flag.detector === "honeypot" ? "Posted in a selected honeypot channel." : "Repeated the same message across " + flag.channelIds.length + " channels."}</p>
    <p className="hint">Channels: {(flag.channelIds.length ? flag.channelIds : [flag.channelId]).map((id) => "#" + channelName(id)).join(", ")}</p>
    {guildId && <a className="inline-link" href={"https://discord.com/channels/" + guildId + "/" + flag.channelId + "/" + flag.messageId} target="_blank" rel="noreferrer">Open message in Discord</a>}
    <details className="audit"><summary>Audit details</summary><dl>
      <div><dt>Member ID</dt><dd>{flag.userId}</dd></div><div><dt>Message ID</dt><dd>{flag.messageId}</dd></div>
      {flag.resolvedBy && <div><dt>Reviewed by</dt><dd>{flag.resolvedBy}</dd></div>}
      {flag.resolvedAt && <div><dt>Reviewed at</dt><dd>{new Date(flag.resolvedAt).toLocaleString()}</dd></div>}
    </dl></details>
    {flag.status === "open" && onReview && <div className="actions flag-actions">
      <button type="button" disabled={busy} onClick={() => onReview(flag, "dismissed")}>Dismiss flag</button>
      <button className="primary" type="button" disabled={busy} onClick={() => onReview(flag, "confirmed")}>Confirm flag</button>
    </div>}
  </article>;
}

function gatewayLabel(status: GatewayStatus["status"]) {
  if (status === "ready") return "Protection is running";
  if (status === "connecting" || status === "reconnecting") return "Connecting to Discord";
  if (status === "error") return "Protection needs attention";
  return "Protection is paused";
}
