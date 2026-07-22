export interface ConsoleAsset {
  readonly contentType: string;
  readonly body: string;
}

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Miftah Console</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  <main id="main" class="shell">
    <header class="masthead">
      <div>
        <p class="eyebrow">Local control plane</p>
        <h1>Miftah <span>Console</span></h1>
      </div>
      <p class="local-mark"><span aria-hidden="true"></span>127.0.0.1 only</p>
    </header>

    <section id="unlock-view" class="gate" aria-labelledby="unlock-title">
      <div>
        <p class="step">01 / Unlock</p>
        <h2 id="unlock-title">Use the one-time code from your terminal</h2>
        <p>The code stays in this page's memory, works once, and is never written to browser storage.</p>
      </div>
      <form id="unlock-form">
        <label for="bootstrap">One-time Console code</label>
        <div class="input-row">
          <input id="bootstrap" name="bootstrap" type="password" autocomplete="off" required minlength="16">
          <button type="submit">Open Console</button>
        </div>
        <p class="field-note">This is not a provider password. Miftah never asks for provider passwords.</p>
      </form>
    </section>

    <div id="dashboard-view" hidden>
      <section class="intro" aria-labelledby="intro-title">
        <p class="step">Connection ownership</p>
        <h2 id="intro-title">Know who owns authentication before you connect</h2>
        <div class="mode-grid">
          <article class="mode mode-native">
            <p class="mode-tag">Managed here</p>
            <h3>Remote native OAuth</h3>
            <p>Miftah discovers standards-based endpoints, opens consent, and stores tokens only in the OS vault.</p>
          </article>
          <article class="mode">
            <p class="mode-tag">Provider-owned login</p>
            <h3>Provider adapter</h3>
            <p>Miftah launches a pinned local adapter. The upstream owns browser login and its private token cache.</p>
          </article>
          <article class="mode">
            <p class="mode-tag">Manual setup</p>
            <h3>Upstream-owned auth</h3>
            <p>Use the provider's documented API key, credential file, or login flow. Miftah passes only configured references.</p>
          </article>
          <article class="mode mode-unsupported">
            <p class="mode-tag">Not imported</p>
            <h3>Unsupported state</h3>
            <p>Passwords, browser cookies, and arbitrary third-party token caches are never accepted or scraped.</p>
          </article>
        </div>
      </section>

      <section id="onboarding-view" class="work-section" hidden aria-labelledby="onboarding-title">
        <div class="section-heading">
          <div>
            <p class="step">02 / First connection</p>
            <h2 id="onboarding-title">Create a native OAuth profile</h2>
          </div>
          <p>Miftah will create one validated v3 configuration. No token or client secret belongs here.</p>
        </div>
        <form id="onboarding-form" class="form-grid">
          <label>Configuration name<input name="name" required maxlength="256" placeholder="posthog-work"></label>
          <label>Profile name<input name="profile" required maxlength="256" placeholder="production"></label>
          <label class="wide">Profile description<input name="description" maxlength="1024" placeholder="Production analytics account"></label>
          <label class="wide">Remote MCP resource URL<input name="resource" type="url" required maxlength="2048" placeholder="https://mcp.example.com/mcp"></label>
          <label class="wide">OAuth issuer URL<input name="issuer" type="url" required maxlength="2048" placeholder="https://auth.example.com"></label>
          <label>Client registration
            <select name="registrationMode">
              <option value="dynamic">Dynamic registration</option>
              <option value="pre-registered">Pre-registered client ID</option>
              <option value="client-id-metadata">Client ID metadata URL</option>
            </select>
          </label>
          <label>Registration value<input name="registrationValue" maxlength="2048" placeholder="Only for non-dynamic modes"></label>
          <label class="wide">Least-privilege scopes<input name="scopes" placeholder="openid analytics:read" aria-describedby="scope-help"></label>
          <p id="scope-help" class="field-note wide">Separate scopes with spaces or commas. Review them before the browser opens.</p>
          <div class="wide form-action"><button type="submit">Create profile and connection</button></div>
        </form>
      </section>

      <div id="workspace-view" hidden>
        <section class="summary" aria-label="Configuration summary">
          <article><p class="summary-label">Configuration</p><strong id="config-name">—</strong><span id="config-version">—</span></article>
          <article><p class="summary-label">Durable default</p><strong id="default-profile">—</strong><span>Existing clients keep their active profile until restart.</span></article>
          <article><p class="summary-label">Audit journal</p><strong id="audit-state">—</strong><span>Redacted local lifecycle records only.</span></article>
        </section>
        <p class="restart-note"><strong>Active vs durable:</strong> Console changes update configuration on disk. Restart Claude Desktop or open a new client connection before expecting the new default or connection to be active.</p>

        <section class="work-section" aria-labelledby="connections-title">
          <div class="section-heading">
            <div><p class="step">Connections</p><h2 id="connections-title">OAuth bindings and local state</h2></div>
            <p>Connect and reauthorize may open the provider in your system browser. Disconnect removes only Miftah's local vault credential; revoke provider access separately.</p>
          </div>
          <div id="connection-list" class="connection-list"></div>
          <details>
            <summary>Add native OAuth to an existing profile</summary>
            <form id="connection-form" class="form-grid compact">
              <label>Profile<select name="profile" id="connection-profile" required></select></label>
              <label>Upstream<select name="upstream" id="connection-upstream" required></select></label>
              <label class="wide">OAuth issuer URL<input name="issuer" type="url" required maxlength="2048"></label>
              <label>Client registration
                <select name="registrationMode">
                  <option value="dynamic">Dynamic registration</option>
                  <option value="pre-registered">Pre-registered client ID</option>
                  <option value="client-id-metadata">Client ID metadata URL</option>
                </select>
              </label>
              <label>Registration value<input name="registrationValue" maxlength="2048"></label>
              <label class="wide">Scopes<input name="scopes" placeholder="openid analytics:read"></label>
              <div class="wide form-action"><button type="submit">Add connection</button></div>
            </form>
          </details>
        </section>

        <section class="work-section split" aria-labelledby="client-title">
          <div>
            <p class="step">Client handoff</p>
            <h2 id="client-title">Review and copy configuration</h2>
            <p>Miftah does not edit Claude, Cursor, or VS Code settings. Copy the generated JSON and merge it yourself.</p>
            <div class="input-row">
              <label class="grow">MCP client
                <select id="client-select">
                  <option value="claude-desktop">Claude Desktop</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="cursor">Cursor</option>
                  <option value="vscode">VS Code</option>
                </select>
              </label>
              <button id="generate-snippet" type="button" class="secondary">Generate</button>
            </div>
          </div>
          <div>
            <label for="snippet-output">Generated JSON</label>
            <textarea id="snippet-output" readonly rows="12" spellcheck="false"></textarea>
            <button id="copy-snippet" type="button">Copy JSON</button>
          </div>
        </section>

        <section class="work-section" aria-labelledby="audit-title">
          <div class="section-heading">
            <div><p class="step">Recent activity</p><h2 id="audit-title">Redacted Console audit</h2></div>
            <button id="refresh-dashboard" type="button" class="secondary">Refresh</button>
          </div>
          <ol id="audit-list" class="audit-list"></ol>
        </section>
      </div>
    </div>
    <p id="status" class="status" role="status" aria-live="polite"></p>
  </main>
  <script src="/app.js" defer></script>
</body>
</html>
`;

const styles = `:root {
  color-scheme: dark;
  --ink: #f4f0e7;
  --muted: #aaa498;
  --line: #343a35;
  --panel: #151a17;
  --panel-raised: #1b211d;
  --ground: #0b0e0c;
  --key: #efb44d;
  --safe: #75c99a;
  --danger: #e08a77;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0;
  min-height: 100vh;
  color: var(--ink);
  background:
    linear-gradient(rgb(255 255 255 / 2%) 1px, transparent 1px),
    linear-gradient(90deg, rgb(255 255 255 / 2%) 1px, transparent 1px),
    radial-gradient(circle at 85% 8%, rgb(239 180 77 / 11%), transparent 32rem),
    linear-gradient(135deg, #0d110f, var(--ground));
  background-size: 4rem 4rem, 4rem 4rem, auto, auto;
}
.skip-link { position: fixed; left: 1rem; top: -4rem; z-index: 10; padding: .7rem 1rem; color: #111; background: var(--key); }
.skip-link:focus { top: 1rem; }
.shell { width: min(76rem, calc(100% - 2rem)); margin: 0 auto; padding: clamp(2.5rem, 7vw, 6rem) 0; }
.masthead { display: flex; align-items: flex-start; justify-content: space-between; gap: 2rem; margin-bottom: clamp(3rem, 7vw, 6rem); }
.eyebrow, .step, .mode-tag, .summary-label { color: var(--key); font: 700 .72rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .14em; text-transform: uppercase; }
h1 { margin: .45rem 0 0; font: 500 clamp(3.4rem, 9vw, 7.5rem)/.88 Georgia, serif; letter-spacing: -.065em; }
h1 span { color: var(--muted); }
h2 { margin: .45rem 0 1rem; font: 500 clamp(1.9rem, 4vw, 3.5rem)/1.03 Georgia, serif; letter-spacing: -.035em; }
h3 { margin: .4rem 0 .7rem; font: 650 1.05rem/1.2 ui-sans-serif, system-ui, sans-serif; }
p { color: var(--muted); line-height: 1.6; }
.local-mark { display: flex; align-items: center; gap: .55rem; margin: .3rem 0; font: 650 .78rem/1 ui-monospace, monospace; }
.local-mark span { width: .6rem; height: .6rem; border-radius: 50%; background: var(--safe); box-shadow: 0 0 0 .3rem rgb(117 201 154 / 12%); }
.gate { display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, 1fr); gap: clamp(2rem, 7vw, 6rem); border-top: 1px solid var(--line); padding: 2rem 0 4rem; }
.gate h2 { max-width: 31rem; }
.field-note { margin: .65rem 0 0; font-size: .8rem; }
.intro, .work-section { border-top: 1px solid var(--line); padding: 2rem 0 clamp(3rem, 7vw, 6rem); }
.mode-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin-top: 2rem; background: var(--line); border: 1px solid var(--line); }
.mode { min-height: 14rem; padding: 1.3rem; background: var(--panel); }
.mode-native { box-shadow: inset 0 .2rem 0 var(--key); }
.mode-unsupported { box-shadow: inset 0 .2rem 0 var(--danger); }
.mode p:last-child { font-size: .88rem; }
.section-heading { display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, .75fr); gap: 3rem; align-items: end; margin-bottom: 2rem; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; padding: clamp(1.2rem, 3vw, 2rem); border: 1px solid var(--line); background: rgb(21 26 23 / 88%); }
.form-grid.compact { margin-top: 1.2rem; }
.wide { grid-column: 1 / -1; }
label { display: block; color: var(--muted); font-size: .82rem; }
input, select, textarea, button { border-radius: .28rem; font: inherit; }
input, select, textarea { width: 100%; margin-top: .55rem; border: 1px solid var(--line); padding: .78rem .85rem; color: var(--ink); background: var(--ground); }
textarea { resize: vertical; font: .78rem/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
input:focus, select:focus, textarea:focus, button:focus-visible, summary:focus-visible { outline: 2px solid var(--key); outline-offset: 2px; }
.input-row { display: flex; align-items: flex-end; gap: .65rem; }
.grow { flex: 1; }
button { min-height: 2.85rem; border: 0; padding: 0 1rem; color: #19150d; background: var(--key); font-weight: 760; cursor: pointer; }
button:hover { filter: brightness(1.08); }
button:disabled { cursor: wait; opacity: .55; }
button.secondary { color: var(--ink); background: var(--panel-raised); border: 1px solid var(--line); }
button.danger { color: #ffd7cf; background: transparent; border: 1px solid #70433a; }
.form-action { display: flex; justify-content: flex-end; }
.summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.summary article { display: flex; min-height: 9rem; flex-direction: column; gap: .45rem; padding: 1.25rem; background: var(--panel); }
.summary strong { font: 500 1.5rem/1.15 Georgia, serif; }
.summary span { color: var(--muted); font-size: .8rem; line-height: 1.45; }
.restart-note { margin: 1rem 0 4rem; padding: 1rem 1.2rem; border-left: .2rem solid var(--key); background: rgb(239 180 77 / 7%); }
.connection-list { display: grid; gap: .8rem; margin-bottom: 1.2rem; }
.connection { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: center; padding: 1rem 1.2rem; border: 1px solid var(--line); background: var(--panel); }
.connection p { margin: .25rem 0 0; font: .77rem/1.5 ui-monospace, monospace; }
.connection-actions { display: flex; flex-wrap: wrap; gap: .45rem; justify-content: flex-end; }
.connection-actions button { min-height: 2.35rem; font-size: .76rem; }
details { border: 1px solid var(--line); padding: 1rem; }
summary { cursor: pointer; font-weight: 700; }
.split { display: grid; grid-template-columns: minmax(0, .8fr) minmax(20rem, 1.2fr); gap: clamp(2rem, 6vw, 5rem); }
.audit-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.audit-list li { display: grid; grid-template-columns: 10rem 1fr auto; gap: 1rem; padding: .8rem 0; border-bottom: 1px solid var(--line); color: var(--muted); font: .76rem/1.45 ui-monospace, monospace; }
.status { position: sticky; bottom: 1rem; min-height: 1.5rem; width: fit-content; max-width: 100%; margin: 1rem 0 0; padding: .7rem 1rem; color: var(--ink); background: #222923; border: 1px solid var(--line); box-shadow: 0 .7rem 2rem rgb(0 0 0 / 35%); }
.status:empty { visibility: hidden; }
@media (max-width: 850px) { .mode-grid, .summary { grid-template-columns: repeat(2, 1fr); } .section-heading, .split { grid-template-columns: 1fr; gap: 1rem; } }
@media (max-width: 620px) { .gate, .form-grid, .mode-grid, .summary { grid-template-columns: 1fr; } .wide { grid-column: 1; } .masthead { flex-direction: column; } .input-row, .connection { align-items: stretch; flex-direction: column; grid-template-columns: 1fr; } .connection-actions { justify-content: flex-start; } .audit-list li { grid-template-columns: 1fr; gap: .2rem; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
`;

const script = `(() => {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const status = byId("status");
  const unlockForm = byId("unlock-form");
  const bootstrapInput = byId("bootstrap");
  const dashboardView = byId("dashboard-view");
  const unlockView = byId("unlock-view");
  const onboardingView = byId("onboarding-view");
  const workspaceView = byId("workspace-view");
  let csrfToken = "";

  function message(text) {
    if (status) status.textContent = text;
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : "The Console request failed.";
  }

  function restoreUnlock() {
    csrfToken = "";
    if (dashboardView) dashboardView.hidden = true;
    if (onboardingView) onboardingView.hidden = true;
    if (workspaceView) workspaceView.hidden = true;
    if (unlockView) unlockView.hidden = false;
    if (bootstrapInput instanceof HTMLInputElement) bootstrapInput.focus();
  }

  async function api(path, options) {
    const request = options || {};
    const headers = { "Accept": "application/json" };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    if (request.method && request.method !== "GET" && request.method !== "HEAD") headers["X-Miftah-CSRF"] = csrfToken;
    const response = await fetch(path, {
      method: request.method || "GET",
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body)
    });
    let payload;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (!response.ok) {
      if (response.status === 401) {
        restoreUnlock();
        throw new Error("The Console session expired. Restart miftah dashboard to get a new one-time code.");
      }
      const publicMessage = payload && payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : "The Console request failed.";
      throw new Error(publicMessage);
    }
    return payload ? payload.data : undefined;
  }

  function registration(form) {
    const data = new FormData(form);
    const mode = String(data.get("registrationMode") || "dynamic");
    const value = String(data.get("registrationValue") || "").trim();
    if (mode === "dynamic") return "dynamic";
    if (!value) throw new Error("Enter the reviewed client ID or metadata URL for this registration mode.");
    return mode + ":" + value;
  }

  function scopes(form) {
    const value = String(new FormData(form).get("scopes") || "");
    return value.split(/[\\s,]+/u).map((scope) => scope.trim()).filter(Boolean);
  }

  function setOptions(select, values) {
    if (!(select instanceof HTMLSelectElement)) return;
    select.replaceChildren();
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    });
  }

  function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function renderConnections(value) {
    const list = byId("connection-list");
    if (!list) return;
    list.replaceChildren();
    const connections = Array.isArray(value) ? value : [];
    if (connections.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No native OAuth connections are configured yet.";
      list.append(empty);
      return;
    }
    connections.forEach((item) => {
      const connection = record(item);
      const reference = typeof connection.connectionRef === "string" ? connection.connectionRef : "";
      const card = document.createElement("article");
      card.className = "connection";
      const details = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = (typeof connection.profile === "string" ? connection.profile : "Unknown profile") +
        " / " + (typeof connection.upstream === "string" ? connection.upstream : "unknown upstream");
      const state = document.createElement("p");
      const credential = typeof connection.credentialState === "string" ? connection.credentialState : "unknown";
      const identity = typeof connection.identityState === "string" ? connection.identityState : "not verified";
      state.textContent = "credential: " + credential + " · identity: " + identity;
      details.append(title, state);
      const actions = document.createElement("div");
      actions.className = "connection-actions";
      [
        ["connect", "Connect", ""],
        ["test", "Test", "secondary"],
        ["reauth", "Reauthorize", "secondary"],
        ["credential", "Remove local credential", "danger"]
      ].forEach((definition) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = definition[1];
        button.className = definition[2];
        button.dataset.connection = reference;
        button.dataset.action = definition[0];
        button.disabled = !reference;
        actions.append(button);
      });
      card.append(details, actions);
      list.append(card);
    });
  }

  function renderAudit(value) {
    const list = byId("audit-list");
    if (!list) return;
    list.replaceChildren();
    const entries = Array.isArray(value) ? value : [];
    if (entries.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "No Console lifecycle events yet.";
      list.append(empty);
      return;
    }
    entries.slice().reverse().forEach((item) => {
      const event = record(item);
      const row = document.createElement("li");
      [event.timestamp || "—", event.operation || "unknown operation", event.status || "unknown"].forEach((value) => {
        const part = document.createElement("span");
        part.textContent = String(value);
        row.append(part);
      });
      list.append(row);
    });
  }

  async function refresh() {
    const metadata = record(await api("/api/v1/config"));
    if (unlockView) unlockView.hidden = true;
    if (dashboardView) dashboardView.hidden = false;
    if (metadata.initialized !== true) {
      if (onboardingView) onboardingView.hidden = false;
      if (workspaceView) workspaceView.hidden = true;
      message("No configuration exists yet. Create the first native OAuth profile below.");
      return;
    }
    if (onboardingView) onboardingView.hidden = true;
    if (workspaceView) workspaceView.hidden = false;
    const configName = byId("config-name");
    const configVersion = byId("config-version");
    const defaultProfile = byId("default-profile");
    if (configName) configName.textContent = String(metadata.name || "—");
    if (configVersion) configVersion.textContent = "Config v" + String(metadata.version || "—");
    if (defaultProfile) defaultProfile.textContent = String(metadata.defaultProfile || "—");
    const profiles = Array.isArray(metadata.profiles) ? metadata.profiles.map((item) => String(record(item).name || "")).filter(Boolean) : [];
    const upstreams = Array.isArray(metadata.upstreams) ? metadata.upstreams.map((item) => String(record(item).name || "")).filter(Boolean) : [];
    setOptions(byId("connection-profile"), profiles);
    setOptions(byId("connection-upstream"), upstreams);
    const results = await Promise.all([
      api("/api/v1/health"),
      api("/api/v1/connections"),
      api("/api/v1/audit?limit=50")
    ]);
    const health = record(results[0]);
    const audit = record(health.audit);
    const auditState = byId("audit-state");
    if (auditState) auditState.textContent = String(audit.state || "unknown");
    renderConnections(results[1]);
    renderAudit(results[2]);
    message("Console data refreshed. Existing MCP clients still need a restart for durable changes.");
  }

  if (unlockForm instanceof HTMLFormElement && bootstrapInput instanceof HTMLInputElement) {
    unlockForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      message("Opening the local Console…");
      try {
        const response = await fetch("/api/v1/sessions", {
          method: "POST",
          headers: { "Authorization": "Bootstrap " + bootstrapInput.value, "Content-Type": "application/json" },
          body: "{}"
        });
        bootstrapInput.value = "";
        const payload = await response.json();
        if (!response.ok || !payload || !payload.data || typeof payload.data.csrfToken !== "string") {
          throw new Error("The one-time code was rejected or expired.");
        }
        csrfToken = payload.data.csrfToken;
        await refresh();
      } catch (error) {
        message(errorMessage(error));
        bootstrapInput.focus();
      }
    });
  }

  const onboardingForm = byId("onboarding-form");
  if (onboardingForm instanceof HTMLFormElement) {
    onboardingForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(onboardingForm);
      message("Creating the validated profile and OAuth connection…");
      try {
        await api("/api/v1/onboarding/native-oauth", {
          method: "POST",
          body: {
            name: String(data.get("name") || "").trim(),
            profile: String(data.get("profile") || "").trim(),
            description: String(data.get("description") || "").trim() || undefined,
            resource: String(data.get("resource") || "").trim(),
            issuer: String(data.get("issuer") || "").trim(),
            clientRegistration: registration(onboardingForm),
            scopes: scopes(onboardingForm)
          }
        });
        onboardingForm.reset();
        await refresh();
      } catch (error) { message(errorMessage(error)); }
    });
  }

  const connectionForm = byId("connection-form");
  if (connectionForm instanceof HTMLFormElement) {
    connectionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(connectionForm);
      message("Adding the reviewed OAuth binding…");
      try {
        await api("/api/v1/connections", {
          method: "POST",
          body: {
            profile: String(data.get("profile") || ""),
            upstream: String(data.get("upstream") || ""),
            issuer: String(data.get("issuer") || "").trim(),
            clientRegistration: registration(connectionForm),
            scopes: scopes(connectionForm)
          }
        });
        connectionForm.reset();
        await refresh();
      } catch (error) { message(errorMessage(error)); }
    });
  }

  const connectionList = byId("connection-list");
  if (connectionList) {
    connectionList.addEventListener("click", async (event) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
      if (!(button instanceof HTMLButtonElement)) return;
      const reference = button.dataset.connection || "";
      const action = button.dataset.action || "";
      if (!reference || !action) return;
      button.disabled = true;
      message(action === "credential" ? "Removing the exact local vault credential…" : "Running " + action + "…");
      try {
        await api("/api/v1/connections/" + encodeURIComponent(reference) + "/" + action, {
          method: action === "credential" ? "DELETE" : "POST",
          body: {}
        });
        await refresh();
      } catch (error) { message(errorMessage(error)); }
      finally { button.disabled = false; }
    });
  }

  const generateSnippet = byId("generate-snippet");
  if (generateSnippet instanceof HTMLButtonElement) {
    generateSnippet.addEventListener("click", async () => {
      const select = byId("client-select");
      const output = byId("snippet-output");
      if (!(select instanceof HTMLSelectElement) || !(output instanceof HTMLTextAreaElement)) return;
      try {
        const snippets = await api("/api/v1/client-snippets?client=" + encodeURIComponent(select.value));
        const first = Array.isArray(snippets) ? record(snippets[0]) : {};
        output.value = typeof first.json === "string" ? first.json : "";
        message("Generated copy-only client configuration. Review it before merging.");
      } catch (error) { message(errorMessage(error)); }
    });
  }

  const copySnippet = byId("copy-snippet");
  if (copySnippet instanceof HTMLButtonElement) {
    copySnippet.addEventListener("click", async () => {
      const output = byId("snippet-output");
      if (!(output instanceof HTMLTextAreaElement) || !output.value) return;
      try {
        await navigator.clipboard.writeText(output.value);
        message("Client JSON copied. Miftah did not modify any client file.");
      } catch {
        output.focus();
        output.select();
        message("Clipboard access was unavailable. The JSON is selected for manual copy.");
      }
    });
  }

  const refreshButton = byId("refresh-dashboard");
  if (refreshButton instanceof HTMLButtonElement) {
    refreshButton.addEventListener("click", () => void refresh().catch((error) => message(errorMessage(error))));
  }
})();
`;

const assets: Readonly<Record<string, ConsoleAsset>> = Object.freeze({
  "/": { contentType: "text/html; charset=utf-8", body: page },
  "/app.css": { contentType: "text/css; charset=utf-8", body: styles },
  "/app.js": { contentType: "text/javascript; charset=utf-8", body: script }
});

export function consoleAsset(path: string): ConsoleAsset | undefined {
  return Object.hasOwn(assets, path) ? assets[path] : undefined;
}
