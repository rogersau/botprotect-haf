import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Bell, BookOpen, Check, CheckCheck, ChevronDown, CircleHelp, Cloud, Code2, ExternalLink, Fingerprint, Flag as FlagIcon, Hash, LayoutDashboard, LoaderCircle, LogIn, LogOut, Menu, MessageSquare, Radio, RefreshCw, Shield, ShieldCheck, ShieldOff, SlidersHorizontal, Sparkles, Waypoints, X } from "lucide-react";
import { DEFAULT_SETTINGS, type AppSession, type Dashboard, type Flag, type GuildResources, type Settings } from "../shared/types";
import { createDemoDashboard, demoResources } from "./demo";

type Page = "overview" | "protections" | "review" | "setup";
const pages: { id: Page; label: string; icon: typeof Shield }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "protections", label: "Protections", icon: ShieldCheck },
  { id: "review", label: "Review queue", icon: FlagIcon },
  { id: "setup", label: "Setup guide", icon: BookOpen },
];
const initialPage = (): Page => pages.some((p) => p.id === location.hash.slice(1)) ? location.hash.slice(1) as Page : "overview";

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...init.headers } });
  if (response.status === 204) return undefined as T;
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "The request failed. Please try again.");
  return body;
}

export function App() {
  const [page, setPage] = useState<Page>(initialPage);
  const [session, setSession] = useState<AppSession | null>(null);
  const [data, setData] = useState<Dashboard>(createDemoDashboard);
  const [resources, setResources] = useState<GuildResources>(demoResources);
  const [settings, setSettings] = useState<Settings>(data.settings);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [filter, setFilter] = useState("all");
  const [period, setPeriod] = useState("7");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const demo = !session?.authenticated;
  const dockerHosting = session?.hosting === "docker";
  const dirty = JSON.stringify(settings) !== JSON.stringify(data.settings);
  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 6500);
  }, []);

  const navigate = (target: Page) => { setPage(target); location.hash = target; setMobileNav(false); window.scrollTo({ top: 0, behavior: "smooth" }); };
  useEffect(() => {
    const listener = () => setPage(initialPage());
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const current = await api<AppSession>("/api/session");
        if (!active) return;
        setSession(current);
        if (current.authenticated) {
          setResources({ guild: { id: current.guildId!, name: "Your Discord server", icon: null, owner_id: "" }, channels: [], roles: [] });
          setData({ settings: { ...DEFAULT_SETTINGS }, gateway: { status: "stopped", error: null, connectedAt: null, lastEventAt: null }, stats: { messages: 0, honeypot: 0, spam: 0, pending: 0 }, flags: [], activity: [], jobsPending: 0, jobsFailed: 0 });
          setSettings({ ...DEFAULT_SETTINGS });
          const dashboard = await api<Dashboard>("/api/dashboard");
          if (!active) return;
          setData(dashboard); setSettings(dashboard.settings);
          try { const info = await api<GuildResources>("/api/resources"); if (active) setResources(info); }
          catch (error) { if (active) setResourceError(errorText(error)); }
        }
      } catch (error) { if (active) notify(errorText(error), true); }
      finally { if (active) setLoading(false); }
    }
    void load();
    const authError = new URLSearchParams(location.search).get("auth_error");
    if (authError) { notify(authError, true); history.replaceState(null, "", `${location.pathname}${location.hash}`); }
    return () => { active = false; };
  }, [notify]);
  useEffect(() => {
    if (!session?.authenticated) return;
    const interval = setInterval(() => { void api<Dashboard>("/api/dashboard").then(setData).catch((error) => notify(errorText(error), true)); }, 15_000);
    return () => clearInterval(interval);
  }, [session?.authenticated, notify]);
  useEffect(() => { if (!dirty) return; const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard); }, [dirty]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  async function save() {
    setBusy(true);
    try {
      if (settings.honeypotEnabled && !settings.honeypotChannelIds.length) throw new Error("Choose a honeypot channel before enabling it.");
      if (!demo) await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      setData((current) => ({ ...current, settings: structuredClone(settings) }));
      notify(demo ? "Demo settings saved for this visit. Connect Discord to protect your server." : "Your protection settings are saved.");
    } catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  }
  async function gateway() {
    setBusy(true);
    try {
      const running = data.gateway.status === "ready" || data.gateway.status === "connecting" || data.gateway.status === "reconnecting";
      if (demo) {
        setData((current) => ({ ...current, gateway: { ...current.gateway, status: running ? "stopped" : "ready" } }));
        notify(`Demo protection ${running ? "paused" : "started"}. No Discord server is connected.`);
      } else {
        const state = await api<Dashboard["gateway"]>(`/api/gateway/${running ? "stop" : "start"}`, { method: "POST" });
        setData((current) => ({ ...current, gateway: state }));
        notify(running ? "Protection paused. You can start it again at any time." : "Connecting to Discord. Status will update automatically.");
      }
    } catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  }
  async function review(flag: Flag, status: "confirmed" | "dismissed") {
    setBusy(true);
    try {
      if (!demo) await api(`/api/flags/${flag.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      setData((current) => ({ ...current, flags: current.flags.map((item) => item.id === flag.id ? { ...item, status, resolvedBy: session?.user?.id || "demo", resolvedAt: Date.now() } : item), stats: { ...current.stats, pending: Math.max(0, current.stats.pending - 1) } }));
      notify(`${demo ? "Demo flag" : "Flag"} ${status}. ${status === "confirmed" ? "No account action was taken." : "The member can continue as normal."}`);
    } catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  }
  async function setupCheck() {
    setBusy(true);
    try {
      if (demo) { notify("This is a demo. Add your Discord credentials to run the connection check."); return; }
      const result = await api<{ note: string }>("/api/setup/check"); notify(result.note);
      const info = await api<GuildResources>("/api/resources"); setResources(info); setResourceError(null);
    } catch (error) { notify(errorText(error), true); }
    finally { setBusy(false); }
  }
  const channelName = (id: string) => resources.channels.find((channel) => channel.id === id)?.name || id;
  const ready = data.gateway.status === "ready";
  const activeDetectors = Number(data.settings.honeypotEnabled) + Number(data.settings.spamEnabled);

  if (loading) return <div className="initial-loading"><ShieldCheck size={42} /><span>Opening BotProtect…</span><LoaderCircle className="spin" size={20} /></div>;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
      <a href="#overview" className="brand" onClick={(e) => { e.preventDefault(); navigate("overview"); }}><span className="brand-icon"><ShieldCheck size={23} strokeWidth={2} /></span><span>BotProtect<span className="brand-by">BY HAFBOT</span></span></a>
      <button className="guild-switch" onClick={() => navigate("setup")} aria-label="View server setup"><span className="guild-avatar">{demo || resourceError ? "H" : resources.guild.name.charAt(0)}</span><span><strong>{demo ? "The Harbour" : resourceError ? "Your Discord server" : resources.guild.name}</strong><small>{demo ? "Demo workspace" : "Your server, your rules"}</small></span><ChevronDown size={15} /></button>
      <p className="nav-caption">WORKSPACE</p>
      <nav aria-label="Main navigation">{pages.map(({ id, label, icon: Icon }) => <a href={`#${id}`} key={id} className={`nav-item ${page === id ? "selected" : ""}`} onClick={(e) => { e.preventDefault(); navigate(id); }}><Icon size={19} /><span>{label}</span>{id === "review" && data.stats.pending > 0 && <span className="nav-count">{data.stats.pending}</span>}{id === "setup" && <ArrowUpRight className="nav-arrow" size={15} />}</a>)}</nav>
      <div className="sidebar-bottom"><div className="own-server"><span className="mini-icon"><Cloud size={19} /></span><strong>Small app. Your {dockerHosting ? "server" : "cloud"}.</strong><p>One server. One deployment.<br />Always in your hands.</p><button className="text-link" onClick={() => navigate("setup")}>Deployment guide <ArrowUpRight size={14} /></button></div>
        <a className="source-link" href="https://hafbot.xyz" target="_blank" rel="noreferrer"><Code2 size={17} /> Meet HAFBOT <ArrowUpRight size={14} /></a><div className="sidebar-version"><span className="status-dot" /> Open source · MIT <span>v0.1.0</span></div></div>
    </aside>
    {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={22} /></button><span>Workspace</span><span className="crumb-slash">/</span><strong>{pages.find((p) => p.id === page)?.label}</strong></div><div className="topbar-right"><span className={`connection-pill ${demo ? "demo-pill" : ready ? "" : "offline"}`}><span className="status-dot" />{demo ? "Demo mode" : ready ? "Discord connected" : "Discord not connected"}</span><button className="icon-button help-button" title="Setup guide" aria-label="Open setup guide" onClick={() => navigate("setup")}><CircleHelp size={19} /></button>{demo ? <a className="button button-small button-dark" href={session?.configured ? "/auth/login" : "#setup"} onClick={(e) => { if (!session?.configured) { e.preventDefault(); navigate("setup"); } }}>{session?.configured ? <LogIn size={15} /> : <Cloud size={15} />}{session?.configured ? "Sign in with Discord" : "Connect your server"}</a> : <button className="account-button" title={`Sign out ${session?.user?.username}`} onClick={() => { void api("/auth/logout", { method: "POST" }).then(() => location.reload()).catch((error) => notify(errorText(error), true)); }}><span>{session?.user?.username.charAt(0).toUpperCase()}</span><LogOut size={15} /></button>}</div></header>
      <main>
        {demo && <div className="demo-banner"><Sparkles size={15} /><span>You’re exploring a demo. All activity is sample data.</span><button onClick={() => navigate("setup")}>Make it yours <ArrowRight size={14} /></button></div>}
        {resourceError && !demo && <div className="alert"><CircleHelp size={18} /><span>{resourceError} Invite the bot and check its permissions in the setup guide.</span><button className="text-link" onClick={() => navigate("setup")}>Open setup</button></div>}
        {data.gateway.error && <div className="alert"><Radio size={18} /><span>{data.gateway.error}</span></div>}
        {data.jobsFailed > 0 && <div className="alert"><Bell size={18} /><span>{data.jobsFailed} Discord message action{data.jobsFailed === 1 ? " needs" : "s need"} attention. Check the bot’s channel permissions, then retry.</span><button className="text-link" onClick={() => { void api("/api/jobs/retry", { method: "POST" }).then(() => notify("Message actions queued for another attempt.")).catch((e) => notify(errorText(e), true)); }}>Retry actions</button></div>}

        {page === "overview" && <>
          <PageHeading eyebrow="A LITTLE PEACE OF MIND" title="Good company. Less spam." description="A quiet watch over your Discord community." aside={<button className="button button-light" disabled={busy} onClick={gateway}>{busy ? <LoaderCircle className="spin" size={15} /> : ready ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}{ready ? "Pause protection" : "Start protection"}</button>} />
          <section className="hero-card"><div className="hero-content"><span className={`hero-status ${ready ? "" : "paused"}`}><span className="status-dot" />{ready ? demo ? "PREVIEWING PROTECTION" : "PROTECTION IS RUNNING" : "PROTECTION IS PAUSED"}</span><h2>Your people.<br />Our watch.</h2><p>Catch the bots. Keep the conversation.<br />HAFBOT’s protection, made yours.</p><button className="button hero-button" onClick={() => navigate("protections")}>Manage protections <ArrowRight size={16} /></button><div className="hero-footnote"><CheckCheck size={15} />{activeDetectors} of 2 detectors enabled <span>·</span> Moderators make the call</div></div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" /><span className="art-plus plus-one">+</span><span className="art-plus plus-two">+</span><span className="art-dot dot-one" /><span className="art-dot dot-two" /><div className="shield-shadow" /><svg className="big-shield" viewBox="0 0 180 206"><defs><linearGradient id="shieldGradient" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#e3f1bd" /><stop offset="1" stopColor="#b9d691" /></linearGradient></defs><path d="M90 9 161 36v57c0 51-71 100-71 100S19 144 19 93V36Z" fill="url(#shieldGradient)" stroke="#f5ffdc" strokeWidth="3" /><path d="M90 22 149 45v48c0 41-59 86-59 86S31 134 31 93V45Z" fill="none" stroke="#91b671" strokeWidth="1.2" /><path d="m61 98 20 20 41-43" fill="none" stroke="#264d37" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" /></svg><div className="art-tag tag-honeypot"><Fingerprint size={17} /><span>Honeypot active</span><span className="tiny-dot" /></div><div className="art-tag tag-spam"><Waypoints size={17} /><span>Spam? Handled.</span><Check size={14} /></div></div></section>
          <div className="section-kicker"><span>TODAY AT A GLANCE</span><span><span className="status-dot" />{demo ? "Sample activity" : "Refreshes every 15 seconds"} · UTC</span></div>
          <div className="stats-grid"><Stat label="Messages checked" value={data.stats.messages} icon={<MessageSquare size={18} />} detail="Conversations, quietly watched" /><Stat label="Honeypot flags" value={data.stats.honeypot} icon={<Fingerprint size={18} />} detail="A tripwire for unwanted guests" tone="orange" /><Stat label="Spam flags" value={data.stats.spam} icon={<Waypoints size={18} />} detail="Repeated messages, spotted" tone="purple" /><Stat label="Awaiting review" value={data.stats.pending} icon={<FlagIcon size={18} />} detail={<button onClick={() => navigate("review")}>Open review queue <ArrowRight size={13} /></button>} tone="yellow" /></div>
          <div className="overview-columns"><section className="panel activity-panel"><div className="panel-heading"><div><h3>Protection activity</h3><p>A little less noise, every day.</p></div><label className="period-select"><span className="sr-only">Activity period</span><select value={period} onChange={(e) => setPeriod(e.target.value)}><option value="7">Last 7 days</option><option value="3">Last 3 days</option></select></label></div><ActivityChart activity={data.activity.slice(-Number(period))} /><div className="chart-legend"><span><i className="legend-dot green" /> Honeypot</span><span><i className="legend-dot peach" /> Cross-channel spam</span></div></section><section className="panel detectors-summary"><div className="panel-heading"><div><h3>Your protections</h3><p>Two simple ways to stay ahead.</p></div><ShieldCheck size={18} /></div><DetectorSummary icon={<Fingerprint size={20} />} title="Honeypot" text="The channel bots can’t resist." enabled={data.settings.honeypotEnabled} tone="orange" onClick={() => navigate("protections")} /><DetectorSummary icon={<Waypoints size={20} />} title="Cross-channel spam" text="Same message. Different channels." enabled={data.settings.spamEnabled} tone="purple" onClick={() => navigate("protections")} /><button className="summary-footer" onClick={() => navigate("protections")}>Fine-tune your protection <ArrowRight size={15} /></button></section></div>
          <section className="panel recent-panel"><div className="panel-heading"><div><h3>Recent flags <span className="subtle-count">{data.flags.length}</span></h3><p>A signal for your team to take a closer look.</p></div><button className="text-link" onClick={() => navigate("review")}>View all activity <ArrowUpRight size={15} /></button></div><FlagTable flags={data.flags.slice(0, 3)} channelName={channelName} onOpen={() => navigate("review")} /></section>
          <div className="community-note"><span>✳</span><p>Built for communities. <strong>Brought to you by HAFBOT.</strong></p><a href="https://hafbot.xyz" target="_blank" rel="noreferrer">Meet the project <ArrowUpRight size={13} /></a></div>
        </>}

        {page === "protections" && <>
          <PageHeading eyebrow="YOUR SERVER, YOUR RULES" title="A few good boundaries." description="Choose what to watch. Your team decides what happens next." aside={<button className="button button-dark" onClick={save} disabled={busy || !dirty}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Save changes</button>} />
          {dirty && <div className="save-notice">You have unsaved changes.<button onClick={() => setSettings(structuredClone(data.settings))}>Discard changes</button></div>}
          <div className="protection-grid"><section className="panel protection-card"><div className="protection-card-heading"><span className="feature-icon orange"><Fingerprint size={25} /></span><Toggle label="Enable honeypot detector" checked={settings.honeypotEnabled} onChange={(v) => update("honeypotEnabled", v)} /></div><span className="eyebrow">THE QUIET TRIPWIRE</span><h2>Honeypot</h2><p>Flag anyone who posts in a clearly marked, off-limits channel. A simple trap for automated accounts.</p><label className="field-label" htmlFor="honeypot-channel">Add a honeypot channel <span>Up to 10</span></label><select id="honeypot-channel" value="" onChange={(e) => { if (e.target.value && settings.honeypotChannelIds.length < 10) update("honeypotChannelIds", [...new Set([...settings.honeypotChannelIds, e.target.value])]); }}><option value="">Choose a channel…</option>{resources.channels.filter((c) => [0, 5].includes(c.type) && !settings.honeypotChannelIds.includes(c.id)).map((c) => <option value={c.id} key={c.id}># {c.name}</option>)}</select><div className="chips">{settings.honeypotChannelIds.map((id) => <span className="chip" key={id}><Hash size={13} />{channelName(id)}<button aria-label={`Remove ${channelName(id)}`} onClick={() => update("honeypotChannelIds", settings.honeypotChannelIds.filter((c) => c !== id))}><X size={13} /></button></span>)}</div><div className="field-hint">Use a channel like #do-not-post with a clear warning. Members must be able to see and send messages in it. Forum posts are ignored.</div><MessageActions warn={settings.honeypotWarn} remove={settings.honeypotDelete} onWarn={(v) => update("honeypotWarn", v)} onRemove={(v) => update("honeypotDelete", v)} prefix="honeypot" /></section>
          <section className="panel protection-card"><div className="protection-card-heading"><span className="feature-icon purple"><Waypoints size={25} /></span><Toggle label="Enable cross-channel spam detector" checked={settings.spamEnabled} onChange={(v) => update("spamEnabled", v)} /></div><span className="eyebrow">CATCH THE COPY & PASTE</span><h2>Cross-channel spam</h2><p>Spot the same member repeating the same message across different channels in a short time.</p><div className="number-fields"><label className="field-label">Different channels<input type="number" min="2" max="20" value={settings.spamThreshold} onChange={(e) => update("spamThreshold", Number(e.target.value))} /><small>Between 2 and 20</small></label><label className="field-label">Within seconds<input type="number" min="5" max="300" value={settings.spamWindowSeconds} onChange={(e) => update("spamWindowSeconds", Number(e.target.value))} /><small>Between 5 and 300</small></label></div><div className="rule-preview"><Waypoints size={17} /><span>Same message in <strong>{settings.spamThreshold} channels</strong> within <strong>{settings.spamWindowSeconds} seconds</strong> → flag for review.</span></div><div className="field-hint">Case, Unicode width, and extra spaces are normalized. Empty and attachment-only messages don’t count.</div><MessageActions warn={settings.spamWarn} remove={settings.spamDelete} onWarn={(v) => update("spamWarn", v)} onRemove={(v) => update("spamDelete", v)} prefix="spam" /></section></div>
          <section className="panel shared-settings"><div className="panel-heading"><div><h3>The people you trust</h3><p>Shared settings for both detectors.</p></div><SlidersHorizontal size={20} /></div><div className="shared-settings-grid"><div><label className="field-label" htmlFor="excluded-role">Exclude trusted roles</label><select id="excluded-role" value="" onChange={(e) => { if (e.target.value) update("excludedRoleIds", [...new Set([...settings.excludedRoleIds, e.target.value])]); }}><option value="">Choose a role to exclude…</option>{resources.roles.filter((r) => r.id !== resources.guild.id && !settings.excludedRoleIds.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select><div className="chips">{settings.excludedRoleIds.map((id) => <span className="chip" key={id}>@ {resources.roles.find((r) => r.id === id)?.name || id}<button aria-label="Remove excluded role" onClick={() => update("excludedRoleIds", settings.excludedRoleIds.filter((r) => r !== id))}><X size={13} /></button></span>)}</div><p className="field-hint">Bots and webhooks are always ignored. Excluded roles bypass both detectors.</p></div><div><label className="field-label" htmlFor="review-channel">Discord review notifications</label><select id="review-channel" value={settings.reviewChannelId || ""} onChange={(e) => update("reviewChannelId", e.target.value || null)}><option value="">Dashboard only</option>{resources.channels.filter((c) => [0, 5].includes(c.type)).map((c) => <option key={c.id} value={c.id}># {c.name}</option>)}</select><p className="field-hint">Send new flags to a private staff channel. Review and resolve them here in the dashboard.</p></div></div></section><div className="info-note"><ShieldCheck size={20} /><p><strong>A flag starts a conversation.</strong> BotProtect never automatically bans, kicks, times out, or changes member roles. Confirming a flag records a decision. Apply account actions in Discord.</p></div>
        </>}

        {page === "review" && <>
          <PageHeading eyebrow="A HUMAN TAKES IT FROM HERE" title="A second pair of eyes." description="Review the evidence. Make the call. Keep your community welcoming." aside={<span className="queue-count"><FlagIcon size={17} />{data.stats.pending} awaiting review</span>} />
          <div className="review-toolbar"><div className="filter-tabs" role="group" aria-label="Filter flags">{["all", "open", "confirmed", "dismissed"].map((status) => <button className={filter === status ? "active" : ""} onClick={() => setFilter(status)} key={status}>{status === "all" ? "All flags" : status === "open" ? "Needs review" : capitalize(status)}</button>)}</div><span>Latest 100 flags · retained for 30 days</span></div>
          <div className="review-list">{data.flags.filter((f) => filter === "all" || f.status === filter).map((flag) => <article className="panel review-card" key={flag.id}><div className="review-card-top"><span className={`feature-icon ${flag.detector === "honeypot" ? "orange" : "purple"}`}>{flag.detector === "honeypot" ? <Fingerprint size={21} /> : <Waypoints size={21} />}</span><div><h3>{flag.detector === "honeypot" ? "Honeypot triggered" : "Repeated message across channels"}</h3><p><strong>{flag.username}</strong><span> in </span>#{channelName(flag.channelId)}<span> · </span>{relativeTime(flag.createdAt)}</p></div><StatusBadge status={flag.status} /></div><blockquote>{flag.preview || "No text content. The member posted in a honeypot channel."}</blockquote><div className="evidence-line"><Hash size={14} /><span>{flag.channelIds.length} channel{flag.channelIds.length === 1 ? "" : "s"}: {flag.channelIds.map(channelName).join(", ")}</span></div><details><summary>View evidence & audit details</summary><div className="audit-details"><span>Member ID: {flag.userId}</span><span>Flagged: {new Date(flag.createdAt).toLocaleString()}</span><span>Message ID: {flag.messageId}</span>{flag.resolvedBy && <span>Reviewed by: {flag.resolvedBy}{flag.resolvedAt ? ` on ${new Date(flag.resolvedAt).toLocaleString()}` : ""}</span>}{!demo && <a target="_blank" rel="noreferrer" href={`https://discord.com/channels/${session?.guildId}/${flag.channelId}/${flag.messageId}`}>Open message in Discord <ExternalLink size={13} /></a>}</div></details>{flag.status === "open" && <div className="review-card-actions"><span>Confirming records a decision. No member punishment is applied.</span><button className="button button-light button-small" disabled={busy} onClick={() => review(flag, "dismissed")}><X size={15} />Dismiss</button><button className="button button-dark button-small" disabled={busy} onClick={() => review(flag, "confirmed")}><Check size={15} />Confirm bot</button></div>}</article>)}{!data.flags.some((f) => filter === "all" || f.status === filter) && <div className="panel empty-state"><ShieldCheck size={42} /><h3>All quiet here.</h3><p>{filter === "all" ? "New detections will appear here, ready for your team to review." : "There are no flags in this view."}</p></div>}</div>
        </>}

        {page === "setup" && <>
          <PageHeading eyebrow="A SMALL SETUP. A SAFER SPACE." title="Make yourself at home." description="Your Discord server. Your hosting. Your protection." aside={<button className="button button-light" disabled={busy} onClick={setupCheck}>{busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}Check connection</button>} />
          <div className="setup-layout"><div className="setup-steps">
          <SetupStep number="01" title="Create your Discord application" description="A dedicated bot keeps this deployment independent and owned by your guild."><p>Open the Discord Developer Portal, create an application, then open <strong>Bot</strong> and copy its token. Enable <strong>Message Content Intent</strong> under Privileged Gateway Intents. No other privileged intent is needed.</p><a className="button button-light button-small" href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">Discord Developer Portal <ArrowUpRight size={14} /></a></SetupStep>
          <SetupStep number="02" title={dockerHosting ? "Run on your own server" : "Deploy to your Cloudflare account"} description={dockerHosting ? "Docker keeps your app and its data together on your own host." : "Deploy from your public copy of this repository using the Cloudflare button."}>
            {dockerHosting ? <><p>Copy <strong>.env.example</strong> to <strong>.env</strong> in your checkout, then fill in the four Discord values below. Start the app with:</p><CopyCode value="docker compose up -d --build" onCopy={() => notify("Docker command copied.")} /><p>Set <strong>PUBLIC_URL</strong> to the HTTPS address your team uses. Use your existing HTTPS proxy, the included Caddy configuration, or optional private access through Tailscale.</p><a className="text-link" href="https://github.com/rogersau/botprotect-haf/blob/main/docs/docker.md" target="_blank" rel="noreferrer">Docker, HTTPS & Tailscale guide <ArrowUpRight size={14} /></a></> : <p>Use the <strong>Deploy to Cloudflare</strong> button in this project’s README. Cloudflare creates the Worker and its storage. Enter these four values when prompted:</p>}
            <div className="secret-list">{["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_GUILD_ID"].map((key) => <div key={key}><code>{key}</code><span className={session?.missing.includes(key) ? "missing-value" : !demo ? "configured-value" : ""}>{session?.missing.includes(key) ? "Required" : !demo ? "Configured" : "From Discord"}</span></div>)}</div><p>Application ID and client secret are under <strong>OAuth2</strong>. For the server ID, enable Discord’s Developer Mode, right-click your server, and select <strong>Copy Server ID</strong>.</p>
          </SetupStep>
          <SetupStep number="03" title="Connect Discord to this app" description="Add the redirect URL, invite the bot, and sign in as a server manager."><p>In the application’s <strong>OAuth2 → Redirects</strong>, add this exact address:</p><CopyCode value={`${location.origin}/auth/callback`} onCopy={() => notify("Redirect URL copied.")} /><p>Invite with <strong>View Channels</strong>, <strong>Send Messages</strong>, <strong>Embed Links</strong>, and <strong>Manage Messages</strong>. Give the bot access to the channels it should watch and the private review channel.</p><div className="inline-actions">{session?.inviteUrl ? <a className="button button-dark button-small" href={session.inviteUrl} target="_blank" rel="noreferrer">Invite your bot <ArrowUpRight size={14} /></a> : <p className="field-hint">Before signing in, invite through Developer Portal → Installation → Guild Install with the permissions above.</p>}{session?.configured && !session.authenticated && <a className="button button-light button-small" href="/auth/login"><LogIn size={15} />Sign in with Discord</a>}</div><p className="field-hint">Dashboard access requires Manage Server, Administrator, or server ownership. Permissions are checked with Discord on each API request.</p></SetupStep>
          <SetupStep number="04" title="Set your tripwires. Start the watch." description="Begin with flags only and tune the detectors for your community."><p>Create a clearly marked <strong>#do-not-post</strong> channel with a warning. Keep it visible and writable for the members you want to monitor. Select it in Protections, choose a private review channel, and exclude trusted roles.</p><p>Start spam detection at <strong>5 distinct channels within 60 seconds</strong>. Save your settings, start protection, and test with a separate, non-excluded account.</p><div className="inline-actions"><button className="button button-dark button-small" onClick={() => navigate("protections")}>Configure protections <ArrowRight size={14} /></button><button className="button button-light button-small" disabled={busy} onClick={gateway}>{ready ? "Pause protection" : "Start protection"}</button></div></SetupStep>
          </div><aside className="setup-aside"><div className="panel setup-note"><Cloud size={28} /><h3>Guild owned.<br />Guild managed.</h3><p>This deployment protects exactly one server. Your credentials, settings, and review history stay {dockerHosting ? "on your own host" : "in your Cloudflare account"}.</p><div className="setup-fact"><Check size={16} />No shared HAFBOT service</div><div className="setup-fact"><Check size={16} />No external database</div><div className="setup-fact"><Check size={16} />Open source under MIT</div></div><div className="setup-cost"><h4>A note on hosting</h4>{dockerHosting ? <><p>Keep your host running to maintain protection. Settings and history are stored in the Docker data volume. Back up that volume and keep it when updating the app.</p><a href="https://github.com/rogersau/botprotect-haf/blob/main/docs/docker.md" target="_blank" rel="noreferrer">Updates & backups <ArrowUpRight size={13} /></a></> : <><p>Watching Discord requires an ongoing connection. Cloudflare compute and storage usage apply. Review your account’s limits and usage before leaving protection running.</p><a href="https://developers.cloudflare.com/durable-objects/platform/pricing/" target="_blank" rel="noreferrer">Cloudflare pricing <ArrowUpRight size={13} /></a></>}</div></aside></div>
        </>}
        <footer className="page-footer"><span><ShieldCheck size={14} />BotProtect <span className="footer-divider">/</span> Brought to you by <strong>HAFBOT</strong></span><span>Your community comes first. <span className="footer-flower">✳</span></span></footer>
      </main>
    </div>
    {toast && <div className={`toast ${toast.error ? "error" : ""}`} role={toast.error ? "alert" : "status"}>{toast.error ? <CircleHelp size={19} /> : <Check size={19} />}<span>{toast.text}</span><button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={17} /></button></div>}
  </div>;
}

const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
function relativeTime(at: number) { const minutes = Math.max(0, Math.floor((Date.now() - at) / 60000)); return minutes < 1 ? "Just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`; }
function PageHeading({ eyebrow, title, description, aside }: { eyebrow: string; title: string; description: string; aside?: ReactNode }) { return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{aside}</div>; }
function Stat({ label, value, icon, detail, tone = "green" }: { label: string; value: number; icon: ReactNode; detail: ReactNode; tone?: string }) { return <section className="stat-card"><div className="stat-top"><span>{label}</span><span className={`stat-icon ${tone}`}>{icon}</span></div><strong>{value.toLocaleString()}</strong><div className="stat-detail">{detail}</div></section>; }
function DetectorSummary({ icon, title, text, enabled, tone, onClick }: { icon: ReactNode; title: string; text: string; enabled: boolean; tone: string; onClick: () => void }) { return <button className="detector-row" onClick={onClick}><span className={`feature-icon ${tone}`}>{icon}</span><span><strong>{title}</strong><small>{text}</small></span><span className={`enabled-badge ${enabled ? "" : "disabled-badge"}`}><span className="status-dot" />{enabled ? "On" : "Off"}</span></button>; }
function StatusBadge({ status }: { status: Flag["status"] }) { return <span className={`flag-status status-${status}`}><span className="status-dot" />{status === "open" ? "Needs review" : capitalize(status)}</span>; }
function FlagTable({ flags, channelName, onOpen }: { flags: Flag[]; channelName: (id: string) => string; onOpen: () => void }) { return flags.length ? <div className="table-scroll"><table><thead><tr><th>MEMBER</th><th>DETECTION</th><th>CHANNEL</th><th>WHEN</th><th>STATUS</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{flags.map((flag, i) => <tr key={flag.id}><td><span className={`member-avatar avatar-${i % 3}`}>{flag.username.slice(0, 1).toUpperCase()}</span><strong>{flag.username}</strong></td><td><span className={`detector-label ${flag.detector === "honeypot" ? "text-orange" : "text-purple"}`}>{flag.detector === "honeypot" ? <Fingerprint size={14} /> : <Waypoints size={14} />}{flag.detector === "honeypot" ? "Honeypot" : "Cross-channel spam"}</span></td><td><span className="channel-label"># {channelName(flag.channelId)}</span></td><td className="time-cell">{relativeTime(flag.createdAt)}</td><td><StatusBadge status={flag.status} /></td><td><button className="icon-button" aria-label={`Review ${flag.username}`} onClick={onOpen}><ArrowUpRight size={16} /></button></td></tr>)}</tbody></table></div> : <div className="quiet-table"><ShieldCheck size={27} /><span>No flags yet. We’ll keep watch.</span></div>; }
function ActivityChart({ activity }: { activity: Dashboard["activity"] }) {
  const max = Math.max(5, ...activity.map((d) => d.honeypot + d.spam));
  return <div className="chart" role="img" aria-label={`Flags over ${activity.length} days: ${activity.map((d) => `${d.day}: ${d.honeypot} honeypot, ${d.spam} spam`).join("; ")}`}><div className="chart-scale">{[max, Math.round(max / 2), 0].map((n, i) => <span key={i}>{n}</span>)}</div><div className="plot"><div className="grid-line grid-top" /><div className="grid-line grid-middle" /><div className="grid-line grid-bottom" /><div className="chart-bars">{activity.map((day, i) => <div className="chart-column" key={day.day}><div className="bar-track"><div className="bar-stack" style={{ height: `${(day.honeypot + day.spam) / max * 100}%` }} title={`${day.honeypot} honeypot, ${day.spam} spam`}><div className="bar-spam" style={{ flex: day.spam }} /><div className="bar-honeypot" style={{ flex: day.honeypot }} /></div></div><span className={i === activity.length - 1 ? "today-label" : ""}>{i === activity.length - 1 ? "Today" : new Date(`${day.day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}</span></div>)}</div></div></div>;
}
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) { return <button type="button" role="switch" aria-label={label} aria-checked={checked} className={`toggle ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}><span /></button>; }
function MessageActions({ warn, remove, onWarn, onRemove, prefix }: { warn: boolean; remove: boolean; onWarn: (v: boolean) => void; onRemove: (v: boolean) => void; prefix: string }) { return <div className="message-actions"><h4>When detected</h4><div className="always-flag"><Check size={15} />Flag for moderator review <span>Always on</span></div><label htmlFor={`${prefix}-warn`}><input id={`${prefix}-warn`} type="checkbox" checked={warn} onChange={(e) => onWarn(e.target.checked)} />Post a warning in the channel</label><label htmlFor={`${prefix}-delete`}><input id={`${prefix}-delete`} type="checkbox" checked={remove} onChange={(e) => onRemove(e.target.checked)} />Delete the triggering message</label></div>; }
function SetupStep({ number, title, description, children }: { number: string; title: string; description: string; children: ReactNode }) { return <section className="panel setup-step"><span className="step-number">{number}</span><div><h2>{title}</h2><p className="step-description">{description}</p><div className="step-body">{children}</div></div></section>; }
function CopyCode({ value, onCopy }: { value: string; onCopy: () => void }) { const [copied, setCopied] = useState(false); return <div className="copy-code"><code>{value}</code><button className="text-link" onClick={() => { void navigator.clipboard.writeText(value).then(() => { setCopied(true); onCopy(); }).catch(() => setCopied(false)); }}>{copied ? "Copied" : "Copy"}</button></div>; }
