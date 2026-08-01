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
        <p class="eyebrow">Local MCP setup</p>
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
      <section id="configuration-catalog-view" class="work-section" hidden aria-labelledby="configuration-catalog-title">
        <div class="section-heading">
          <div>
            <p class="step">Connections and accounts</p>
            <h2 id="configuration-catalog-title">Your MCP connections</h2>
          </div>
          <div class="catalog-actions">
            <p><strong>One connection, named accounts.</strong> Open a connection to manage its accounts, or add another MCP.</p>
            <label for="catalog-client-select">Where do you use this MCP?
              <select id="catalog-client-select">
                <option value="claude-desktop">Claude Desktop</option>
                <option value="claude-code">Claude Code</option>
                <option value="cursor">Cursor</option>
                <option value="vscode">VS Code</option>
              </select>
            </label>
            <p id="catalog-switch-guidance" class="field-note" hidden></p>
            <button id="set-up-another-mcp" type="button">Set up another MCP</button>
          </div>
        </div>
        <div class="configuration-catalog-status" role="status" aria-live="polite" aria-atomic="true">
          <p id="configuration-catalog-summary"></p>
          <ul id="configuration-catalog-attention"></ul>
          <p id="configuration-catalog-rejected-guidance" class="field-note" hidden>Miftah keeps rejected names and paths hidden. For connections you expect to see, check private access, validate the configuration, replace symlinks with regular files, then refresh.</p>
        </div>
        <div id="configuration-catalog" class="configuration-catalog"></div>
        <p class="field-note catalog-boundary">Only validated files in Miftah's standard configuration directory appear here. Client settings and running MCP processes are never inspected.</p>
      </section>

      <section id="setup-completion-view" class="work-section setup-completion" hidden aria-labelledby="setup-completion-title">
        <div class="section-heading">
          <div>
            <p class="step">Finish setup</p>
            <h2 id="setup-completion-title">Finish setup without guessing</h2>
          </div>
          <p>Miftah shows only the checks it actually ran or can safely run. It never treats configuration publication as client adoption.</p>
        </div>
        <div class="setup-completion-copy">
          <article>
            <h3>1. Connection created</h3>
            <p id="setup-completion-created" role="status" aria-live="polite" aria-atomic="true"></p>
          </article>
          <article class="setup-completion-client">
            <h3>2. Install the client entry</h3>
            <div class="input-row">
              <label class="grow">MCP client
                <select id="setup-completion-client-select">
                  <option value="claude-desktop">Claude Desktop</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="cursor">Cursor</option>
                  <option value="vscode">VS Code</option>
                </select>
              </label>
              <button id="setup-completion-generate-entry" type="button">Generate client entry</button>
            </div>
            <p id="setup-completion-client-target" class="field-note"></p>
            <label for="setup-completion-client-json">Generated non-secret client JSON</label>
            <textarea id="setup-completion-client-json" readonly rows="9" spellcheck="false"></textarea>
            <p id="setup-completion-client-guidance" class="field-note"></p>
            <button id="setup-completion-copy-json" type="button" disabled>Copy client JSON</button>
            <p id="setup-completion-handoff"></p>
          </article>
          <article>
            <h3>3. Check readiness</h3>
            <div id="setup-completion-readiness" role="status" aria-live="polite" aria-atomic="true">
              <p id="setup-completion-verification"></p>
              <p id="setup-completion-next-action"></p>
              <p id="setup-completion-environment"></p>
            </div>
          </article>
          <article>
            <h3>4. Add and switch accounts</h3>
            <p id="setup-completion-second-account"></p>
            <p id="setup-completion-switch"></p>
          </article>
        </div>
      </section>

      <section id="setup-wizard-view" class="work-section setup-wizard" hidden aria-labelledby="setup-wizard-title">
        <div class="section-heading">
          <div>
            <p id="setup-wizard-step" class="step">Step 1 of 3 · Choose a path</p>
            <h2 id="setup-wizard-title">Set up another MCP</h2>
          </div>
          <p id="setup-wizard-copy">Start with what you already have. Miftah will show one setup path at a time and will not write anything until that path reaches its create action.</p>
        </div>
        <fieldset id="setup-source-choice" class="setup-source-choice" tabindex="-1">
          <legend>Choose your MCP</legend>
          <p class="field-note">Choose what you have now. The next step asks only for the details needed by that path.</p>
          <div class="setup-source-grid">
            <label class="setup-source-option"><input type="radio" name="setup-source" value="connector" data-setup-source="connector" checked><span>Built-in or custom MCP</span></label>
            <label class="setup-source-option"><input type="radio" name="setup-source" value="remote" data-setup-source="remote"><span>Remote HTTPS endpoint</span></label>
            <label class="setup-source-option"><input type="radio" name="setup-source" value="local" data-setup-source="local"><span>Local executable</span></label>
            <label class="setup-source-option"><input type="radio" name="setup-source" value="browser-sign-in" data-setup-source="browser-sign-in"><span>Remote MCP with browser sign-in</span></label>
            <label class="setup-source-option"><input type="radio" name="setup-source" value="import" data-setup-source="import"><span>Copy an existing client entry</span></label>
          </div>
        </fieldset>
        <div class="setup-wizard-actions">
          <button id="setup-wizard-back" type="button" class="secondary" hidden>Back</button>
          <button id="setup-wizard-cancel" type="button" class="secondary">Cancel setup</button>
          <button id="setup-wizard-continue" type="button">Continue</button>
        </div>
      </section>

      <section id="preset-onboarding-view" class="work-section" hidden aria-labelledby="preset-onboarding-title">
        <div class="section-heading">
          <div>
            <h2 id="preset-onboarding-title">Set up an MCP</h2>
          </div>
          <p>Choose a built-in MCP or describe the custom MCP you already use. The fields below will ask for its package, executable, or HTTPS URL. Browser sign-in is a separate setup path.</p>
        </div>
        <form id="preset-onboarding-form" class="form-grid">
          <label>Configuration name<input name="name" required maxlength="64" pattern="[a-z0-9][a-z0-9._-]{0,63}" placeholder="support-tools"></label>
          <label>Choose an MCP
            <select name="preset" id="preset-selection">
              <optgroup label="Built-in MCPs">
                <option value="sentry">Sentry</option>
                <option value="github">GitHub</option>
                <option value="google-search-console">Google Search Console</option>
                <option value="generic">Example MCP</option>
              </optgroup>
              <optgroup label="Custom MCPs">
                <option value="generic-npx">Exact npx package</option>
                <option value="generic-docker">Pinned Docker image</option>
                <option value="local-stdio">Local executable and arguments</option>
                <option value="streamable-http">Remote HTTPS URL</option>
              </optgroup>
            </select>
          </label>
          <div id="setup-draft-actions" class="wide setup-draft-actions">
            <p class="field-note">Save the configuration name and MCP choice to continue later. Connection details and authentication are entered again when you continue.</p>
            <div class="form-action"><button id="save-setup-draft" type="button" class="secondary">Save MCP choice</button><button id="resume-setup-draft" type="button" class="secondary">Continue saved MCP choice</button><button id="discard-setup-draft" type="button" class="secondary" hidden disabled>Discard saved choice</button></div>
          </div>
          <label class="wide" data-preset-field="generic-npx" hidden>NPM package (exact version)<input name="npmPackage" maxlength="1024" placeholder="@scope/server@1.2.3"></label>
          <label class="wide" data-preset-field="generic-docker" hidden>Docker image (digest pinned)<input name="dockerImage" maxlength="2048" placeholder="registry.example/mcp@sha256:…"></label>
          <label class="wide" data-preset-field="local-stdio" hidden>Local executable<input name="localCommand" maxlength="4096" placeholder="node (macOS/Linux) or C:/tools/server.exe (Windows)"></label>
          <label class="wide" data-preset-field="local-stdio" hidden>Arguments (one argument per line; a blank line is an empty argument)<textarea name="args" maxlength="16384" rows="5" spellcheck="false" autocomplete="off" placeholder="server.mjs&#10;--stdio"></textarea></label>
          <label data-preset-field="local-stdio" hidden>Working directory (optional)<input name="cwd" maxlength="4096" placeholder="/absolute/path/to/project"></label>
          <label class="wide consent" data-preset-field="local-stdio" hidden><input name="acceptLocalCommand" type="checkbox" value="true"> I reviewed this executable and every argument. Miftah will save them as a direct argument array without a shell, will not run them during setup, and no credential is included. On Windows this must be a direct absolute .exe or .com binary, not a .cmd or .bat shim.</label>
          <label class="wide" data-preset-field="streamable-http" hidden>Remote MCP URL<input name="url" type="url" maxlength="2048" placeholder="https://mcp.example.com/mcp"></label>
          <fieldset class="wide gsc-accounts" data-preset-field="google-search-console" hidden>
            <legend>Google Search Console accounts</legend>
            <p class="field-note">Add one named profile per Google account. Miftah gives each profile an isolated upstream token directory; it never reads that token cache.</p>
            <div id="gsc-account-list" class="gsc-account-list"></div>
            <div class="form-action"><button id="add-gsc-account" type="button" class="secondary">Add another Google account</button></div>
            <label>Default account profile<select id="gsc-default-profile" name="defaultProfile" required></select></label>
          </fieldset>
          <label data-preset-field="generic generic-npx generic-docker local-stdio streamable-http">Secret environment variable name (optional)<input name="credentialEnv" maxlength="256" placeholder="MCP_TOKEN"></label>
          <label data-preset-field="streamable-http" hidden>Credential header (optional)<input name="headerName" maxlength="256" placeholder="Authorization"></label>
          <label data-preset-field="streamable-http" hidden>Header prefix (optional)<input name="headerPrefix" maxlength="256" placeholder="Bearer "></label>
          <p class="field-note wide">For provider-owned login such as Google Search Console, Miftah saves the client-secrets path only. The upstream owns its browser login and private token cache. For a local executable, use the environment-variable field for a secret reference; never put a token in an argument.</p>
          <div class="wide form-action"><button type="submit">Review configuration</button></div>
          <div id="preset-review-view" class="wide setup-review" hidden aria-live="polite">
            <p><strong>Review before Miftah writes.</strong> This summary excludes endpoints, paths, launch arguments, credential references, and secret values.</p>
            <p id="preset-review-summary"></p>
            <ul id="preset-review-details"></ul>
            <div class="form-action"><button id="preset-create-reviewed" type="button" disabled>Create reviewed configuration</button><button id="preset-review-edit" type="button" class="secondary">Keep editing</button></div>
          </div>
        </form>
      </section>

      <section id="client-entry-onboarding-view" class="work-section" hidden aria-labelledby="client-entry-onboarding-title">
        <div class="section-heading">
          <div>
            <h2 id="client-entry-onboarding-title">Import one MCP client entry</h2>
          </div>
          <p>Paste one existing Claude, Cursor, or VS Code JSON entry when you want to reuse a supported local executable or explicitly typed HTTPS remote endpoint. Miftah never scans or changes client settings.</p>
        </div>
        <form id="client-entry-onboarding-form" class="form-grid">
          <label>Configuration name<input name="name" required maxlength="64" pattern="[a-z0-9][a-z0-9._-]{0,63}" placeholder="posthog-work"></label>
          <label>Selected MCP entry name<input name="entry" required maxlength="256" placeholder="posthog"></label>
          <label class="wide">Existing client JSON<textarea name="document" required maxlength="65536" rows="12" spellcheck="false" autocomplete="off" placeholder='{"mcpServers":{"posthog":{"command":"npx","args":["--yes","@posthog/mcp@1.2.3"]}}}'></textarea></label>
          <p class="field-note wide">The pasted text is parsed only for this request and cleared from the page afterwards. This flow accepts one selected local <code>stdio</code> entry only when it fits Miftah's static launch grammar: a direct executable, a pinned package runner, or a script path with non-sensitive flags. It also accepts one credential-free HTTPS remote entry explicitly marked <code>type: "http"</code> or <code>"streamable-http"</code>. Remote import does not discover OAuth or call the endpoint. For custom arguments, headers, credentials, or authentication, use advanced manual setup and configure authentication separately.</p>
          <div class="wide form-action"><button type="submit">Import selected entry</button></div>
          <div class="wide manual-recovery">
            <p class="field-note">If import cannot continue, Miftah does not retain rejected arguments, headers, environment values, or credentials. Re-enter a reviewed local executable and literal arguments, or a canonical HTTPS endpoint, yourself.</p>
            <div class="form-action"><button id="client-entry-manual-local" type="button" class="secondary">Set up local executable manually</button><button id="client-entry-manual-remote" type="button" class="secondary">Set up remote HTTPS MCP manually</button></div>
          </div>
        </form>
      </section>

      <section id="onboarding-view" class="work-section" hidden aria-labelledby="onboarding-title">
        <div class="section-heading">
          <div>
            <h2 id="onboarding-title">Set up remote MCP with browser sign-in</h2>
          </div>
          <p>Miftah checks this exact HTTPS endpoint for supported browser sign-in before it creates the configuration. It uses standards-based OAuth with dynamic registration only when the server advertises it. No token, client secret, or browser authorization starts at this step.</p>
        </div>
        <form id="onboarding-form" class="form-grid">
          <label>Configuration name<input name="name" required maxlength="64" pattern="[a-z0-9][a-z0-9._-]{0,63}" placeholder="posthog-work"></label>
          <label>Profile name<input name="profile" required maxlength="256" placeholder="production"></label>
          <label class="wide">Profile description<input name="description" maxlength="1024" placeholder="Production analytics account"></label>
          <label class="wide">Remote MCP resource URL<input name="resource" type="url" required maxlength="2048" placeholder="https://mcp.example.com/mcp"></label>
          <p class="field-note wide">Miftah will stop without writing anything if this endpoint does not publish one supported OAuth authorization server with dynamic client registration. Advanced manual OAuth remains available for provider-specific registrations.</p>
          <div class="wide form-action"><button type="submit">Check sign-in and create profile</button></div>
        </form>
      </section>

      <details id="authentication-guide" class="authentication-guide">
        <summary>How authentication works</summary>
        <div class="authentication-guide-body" aria-labelledby="intro-title">
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
          <p class="restart-note"><strong>Trust boundary:</strong> Profiles and a generated client entry describe local configuration; they do not prove a credential works or belongs to the intended account. A reviewed safe check may establish readiness only where declared, and a configured identity probe is separate. Miftah policy and redacted audit protect the wrapper, not provider-side token scopes or retention.</p>
        </div>
      </details>

      <div id="workspace-view" hidden>
        <nav id="workspace-task-navigation" aria-label="Connection tasks" role="tablist">
          <a id="workspace-task-overview" href="#connection-overview" role="tab" aria-controls="connection-overview" aria-selected="true" tabindex="0" data-workspace-task="connection-overview">Overview</a>
          <a id="workspace-task-accounts" href="#connection-accounts" role="tab" aria-controls="connection-accounts" aria-selected="false" tabindex="-1" data-workspace-task="connection-accounts">Accounts</a>
          <a id="workspace-task-authentication" href="#connection-authentication" role="tab" aria-controls="connection-authentication" aria-selected="false" tabindex="-1" data-workspace-task="connection-authentication">Authentication</a>
          <a id="workspace-task-client-setup" href="#connection-client-setup" role="tab" aria-controls="connection-client-setup" aria-selected="false" tabindex="-1" data-workspace-task="connection-client-setup">Client setup</a>
          <a id="workspace-task-audit" href="#connection-audit" role="tab" aria-controls="connection-audit" aria-selected="false" tabindex="-1" data-workspace-task="connection-audit">Audit</a>
        </nav>
        <section id="connection-overview" class="workspace-task-panel" role="tabpanel" aria-labelledby="workspace-task-overview" tabindex="0">
          <div class="summary" aria-label="Configuration summary">
            <article><p class="summary-label">Configuration</p><strong id="config-name">—</strong><span id="config-version">—</span></article>
            <article><p class="summary-label">Default account for new MCP sessions</p><strong id="default-profile">—</strong><span>Existing sessions keep their active account.</span></article>
            <article><p class="summary-label">Live account switch</p><strong id="profile-switching-state">—</strong><span id="profile-switching-copy">—</span></article>
            <article><p class="summary-label">Audit journal</p><strong id="audit-state">—</strong><span>Redacted local lifecycle records only.</span></article>
          </div>
          <p id="active-profile-guidance" class="restart-note"><strong>Active vs durable:</strong> Console changes update configuration on disk. Existing MCP sessions keep their active account.</p>
        </section>

        <div id="connection-accounts" class="workspace-task-panel" role="tabpanel" aria-labelledby="workspace-task-accounts" tabindex="0" hidden>
        <section class="work-section" aria-labelledby="profile-inventory-title">
          <div class="section-heading">
            <div><p class="step">Configured accounts</p><h2 id="profile-inventory-title">Know which accounts are available</h2></div>
            <p>These are profile names and non-secret labels only. Miftah does not read credentials, headers, launch arguments, token caches, or OAuth vault data to build this list.</p>
          </div>
          <div id="profile-inventory-list" class="profile-inventory-list"></div>
        </section>

        <section id="default-profile-editor" class="work-section" hidden aria-labelledby="default-profile-title">
          <div class="section-heading">
            <div><p class="step">Account selection</p><h2 id="default-profile-title">Choose the default account</h2></div>
            <p>Choose which account new MCP sessions start with. This does not change an active client session, account data, OAuth bindings, or provider-owned token caches.</p>
          </div>
          <div class="input-row">
            <label class="grow">Durable default profile<select id="default-profile-selection" required></select></label>
            <button id="set-default-profile" type="button">Set durable default</button>
          </div>
          <p id="default-profile-result" class="field-note" role="status" aria-live="polite"></p>
        </section>

        <section id="profile-description-editor" class="work-section" hidden aria-labelledby="profile-description-title">
          <div class="section-heading">
            <div><p class="step">Account label</p><h2 id="profile-description-title">Edit a non-secret account label</h2></div>
            <p>Labels help you recognize accounts in Miftah. They do not change credentials, OAuth bindings, routing, provider token caches, or the durable default.</p>
          </div>
          <div class="input-row">
            <label class="grow">Account profile<select id="profile-description-selection" required></select></label>
            <label class="grow">Account label<input id="profile-description-input" maxlength="1024" autocomplete="off" placeholder="Production analytics account"></label>
            <button id="set-profile-description" type="button">Save label</button>
            <button id="clear-profile-description" type="button" class="secondary">Clear label</button>
          </div>
          <p id="profile-description-result" class="field-note" role="status" aria-live="polite"></p>
        </section>

        <section id="profile-rename-editor" class="work-section" hidden aria-labelledby="profile-rename-title">
          <div class="section-heading">
            <div><p class="step">Account lifecycle</p><h2 id="profile-rename-title">Rename an account profile</h2></div>
            <p>Renaming updates this configuration's durable default, routing, plugin, and lock references. For native OAuth, it also moves the exact bound OS-vault credential and non-secret connection metadata through one recoverable local transaction. Provider caches, profile state, identity records, and active sessions stay untouched.</p>
          </div>
          <div class="input-row">
            <label class="grow">Account to rename<select id="profile-rename-selection" required></select></label>
            <label class="grow">New account profile<input id="profile-rename-input" maxlength="256" autocomplete="off" placeholder="production"></label>
            <button id="rename-profile" type="button">Rename account</button>
          </div>
          <p class="field-note">Native OAuth renames keep the new configuration, vault key, and non-secret connection metadata together. Existing MCP clients keep their current session; restart the client before using the new profile name.</p>
          <p id="profile-rename-result" class="field-note" role="status" aria-live="polite"></p>
        </section>

        <section id="profile-removal-editor" class="work-section" hidden aria-labelledby="profile-removal-title">
          <div class="section-heading">
            <div><p class="step">Account lifecycle</p><h2 id="profile-removal-title">Remove an account safely</h2></div>
            <p>Removal changes only Miftah configuration. It never reads or deletes credentials, provider token caches, or OS-vault data. A different account receives any durable default, routing, plugin, or lock reference.</p>
          </div>
          <div class="input-row">
            <label class="grow">Account to remove<select id="profile-removal-selection" required></select></label>
            <label class="grow">Replacement account<select id="profile-removal-replacement" required></select></label>
            <label class="checkbox"><input id="confirm-profile-removal" type="checkbox"> I understand this removes the selected account from this configuration.</label>
            <button id="remove-profile" type="button" class="danger">Remove account</button>
          </div>
          <p class="field-note">Profiles with native OAuth bindings stay protected: Miftah will not split configuration deletion from OS-vault cleanup until it can do both atomically.</p>
          <p id="profile-removal-result" class="field-note" role="status" aria-live="polite"></p>
        </section>
        </div>

        <div id="connection-authentication" class="workspace-task-panel" role="tabpanel" aria-labelledby="workspace-task-authentication" tabindex="0" hidden>
        <section id="provider-authentication-view" class="work-section provider-authentication" hidden aria-labelledby="provider-authentication-title">
          <div class="section-heading">
            <div><p class="step">Authentication ownership</p><h2 id="provider-authentication-title">Authentication setup</h2></div>
            <p id="provider-authentication-copy"></p>
          </div>
        </section>

        <section id="profile-readiness-view" class="work-section profile-readiness" hidden aria-labelledby="profile-readiness-title">
          <div class="section-heading">
            <div><p class="step">First safe call</p><h2 id="profile-readiness-title">Verify an account without guessing</h2></div>
            <p>Miftah runs one provider-declared read-only check for the selected account. It never substitutes an arbitrary tool or exposes provider output here.</p>
          </div>
          <div class="input-row">
            <label class="grow">Account profile<select id="profile-readiness-profile" required></select></label>
            <label class="grow">Upstream<select id="profile-readiness-upstream" required></select></label>
            <button id="run-profile-readiness" type="button">Run reviewed safe check</button>
          </div>
          <p id="profile-readiness-result" class="field-note" role="status" aria-live="polite"></p>
        </section>

        <section class="work-section" aria-labelledby="connections-title">
          <div class="section-heading">
            <div><p class="step">Connections</p><h2 id="connections-title">OAuth bindings and local state</h2></div>
            <p>Connect and reauthorize may open the provider in your system browser. Disconnect removes only Miftah's local vault credential; revoke provider access separately.</p>
          </div>
          <div id="connection-list" class="connection-list"></div>
          <details id="provider-account-editor" hidden>
            <summary>Add another provider account</summary>
            <form id="provider-account-form" class="form-grid compact">
              <label>New account profile name<input name="profile" required maxlength="64" pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="personal"></label>
              <label class="wide">Account description<input name="description" maxlength="1024" placeholder="Personal provider account"></label>
              <label class="wide"><span id="provider-account-credential-label">Provider credential-file path</span><input id="provider-account-credential-file" name="credentialFile" required maxlength="4096" autocomplete="off"></label>
              <label class="wide checkbox"><input name="makeDefault" type="checkbox" value="true"> Make this the durable default profile</label>
              <p class="field-note wide">Miftah stores only the configured credential-file reference and a separate profile. The provider owns browser login and its private token cache; Miftah never reads, copies, or removes that cache.</p>
              <div class="wide form-action"><button type="submit">Add provider account</button></div>
            </form>
          </details>
          <details id="environment-profile-editor" hidden>
            <summary>Add another environment-backed account</summary>
            <form id="environment-profile-form" class="form-grid compact">
              <label>New account profile name<input name="profile" required maxlength="64" pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="personal"></label>
              <label class="wide">Account description<input name="description" maxlength="1024" placeholder="Personal account"></label>
              <label class="wide"><span id="environment-profile-credential-label">Environment variable that holds this account's credential</span><input id="environment-profile-credential-env" name="credentialEnv" required maxlength="256" pattern="[A-Za-z_][A-Za-z0-9_]*" autocomplete="off" placeholder="SERVICE_PERSONAL_TOKEN"></label>
              <label class="wide checkbox"><input name="makeDefault" type="checkbox" value="true"> Make this the durable default profile</label>
              <p class="field-note wide">Miftah stores only an environment-variable reference. It does not read the credential, start this upstream, or copy a provider token cache. This path is available only when the current local MCP has one simple credential environment binding.</p>
              <div class="wide form-action"><button type="submit">Add environment-backed account</button></div>
            </form>
          </details>
          <details id="native-oauth-account-editor">
            <summary>Add another native OAuth account</summary>
            <form id="native-oauth-account-form" class="form-grid compact">
              <label>New account profile name<input name="profile" required maxlength="64" pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="personal"></label>
              <label>Configured upstream<select name="upstream" id="native-oauth-account-upstream" required></select></label>
              <label class="wide">Account description<input name="description" maxlength="1024" placeholder="Personal analytics account"></label>
              <label class="wide checkbox"><input name="makeDefault" type="checkbox" value="true"> Make this the durable default profile</label>
              <p class="field-note wide">Miftah uses the exact HTTPS endpoint already configured for this upstream. It creates a separate profile and OAuth binding, while preserving your existing accounts. No browser authorization starts yet.</p>
              <div class="wide form-action"><button type="submit">Discover OAuth and add account</button></div>
            </form>
          </details>
          <details id="native-oauth-editor">
            <summary>Add native OAuth to an existing profile</summary>
            <form id="connection-form" class="form-grid compact">
              <label>Profile<select name="profile" id="connection-profile" required></select></label>
              <label>Upstream<select name="upstream" id="connection-upstream" required></select></label>
              <p class="field-note wide">Miftah uses the exact HTTPS endpoint already configured for this upstream. It discovers supported OAuth before it changes the configuration; no browser authorization starts yet.</p>
              <div class="wide form-action"><button type="submit">Discover OAuth from configured upstream</button></div>
            </form>
            <details>
              <summary>Advanced manual OAuth registration</summary>
              <p class="field-note">Use this only when the provider gives you pre-registered client details or a client-metadata URL. Miftah cannot safely infer those values.</p>
              <form id="manual-connection-form" class="form-grid compact">
                <label>Profile<select name="profile" id="manual-connection-profile" required></select></label>
                <label>Upstream<select name="upstream" id="manual-connection-upstream" required></select></label>
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
                <div class="wide form-action"><button type="submit">Add manual connection</button></div>
              </form>
            </details>
          </details>
        </section>
        </div>

        <section id="connection-client-setup" class="workspace-task-panel work-section split" role="tabpanel" aria-labelledby="workspace-task-client-setup" tabindex="0" hidden>
          <div>
            <p class="step">Client handoff</p>
            <h2 id="client-title">Review and copy configuration</h2>
            <p>One generated entry serves every named account profile in this configuration. The JSON contains launcher and configuration-path metadata, never credential values. A generated entry does not prove that a credential works or belongs to the intended account. Miftah does not edit Claude, Cursor, or VS Code settings. Copy the generated JSON and merge it yourself.</p>
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
            <p id="snippet-guidance" class="field-note" aria-live="polite"></p>
            <button id="copy-snippet" type="button">Copy JSON</button>
          </div>
        </section>

        <section id="connection-audit" class="workspace-task-panel work-section" role="tabpanel" aria-labelledby="workspace-task-audit" tabindex="0" hidden>
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
.work-section { border-top: 1px solid var(--line); padding: 2rem 0 clamp(3rem, 7vw, 6rem); }
.authentication-guide { margin: 0 0 clamp(3rem, 7vw, 6rem); padding: 0; border: 1px solid var(--line); background: rgb(255 255 255 / 2%); }
.authentication-guide > summary { padding: 1.15rem 1.25rem; color: var(--ink); }
.authentication-guide[open] > summary { border-bottom: 1px solid var(--line); }
.authentication-guide-body { padding: 1.5rem 1.25rem 0; }
.mode-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin-top: 2rem; background: var(--line); border: 1px solid var(--line); }
.mode { min-height: 14rem; padding: 1.3rem; background: var(--panel); }
.mode-native { box-shadow: inset 0 .2rem 0 var(--key); }
.mode-unsupported { box-shadow: inset 0 .2rem 0 var(--danger); }
.mode p:last-child { font-size: .88rem; }
.section-heading { display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, .75fr); gap: 3rem; align-items: end; margin-bottom: 2rem; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; padding: clamp(1.2rem, 3vw, 2rem); border: 1px solid var(--line); background: rgb(21 26 23 / 88%); }
.form-grid.compact { margin-top: 1.2rem; }
.wide { grid-column: 1 / -1; }
fieldset { min-inline-size: 0; margin: 0; }
.setup-source-choice { padding: 1rem; border: 1px solid var(--line); background: var(--ground); }
.setup-source-choice legend { padding: 0 .35rem; color: var(--ink); font-weight: 700; }
.setup-source-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .6rem; margin-top: 1rem; }
.setup-source-option { position: relative; display: block; margin: 0; color: var(--ink); }
.setup-source-option input { position: absolute; inline-size: 1px; block-size: 1px; margin: -1px; opacity: 0; }
.setup-source-option span { display: flex; align-items: center; min-height: 3.3rem; padding: .78rem .85rem; color: var(--ink); background: var(--panel-raised); border: 1px solid var(--line); }
.setup-source-option input:checked + span { color: #19150d; background: var(--key); border-color: var(--key); }
.setup-source-option input:focus-visible + span { outline: 2px solid var(--key); outline-offset: 2px; }
.setup-wizard { scroll-margin-top: 1rem; }
.setup-wizard-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .65rem; margin-top: 1rem; }
#setup-wizard-back { margin-right: auto; }
.gsc-accounts { border: 1px solid var(--line); padding: 1rem; }
.gsc-accounts legend { padding: 0 .35rem; color: var(--ink); font-weight: 700; }
.gsc-account-list { display: grid; gap: 1rem; margin: 1rem 0; }
.gsc-account-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; padding: 1rem; border: 1px solid var(--line); background: var(--ground); }
.gsc-account-row .form-action { display: flex; align-items: end; }
label { display: block; color: var(--muted); font-size: .82rem; }
input, select, textarea, button { border-radius: .28rem; font: inherit; }
input, select, textarea { width: 100%; margin-top: .55rem; border: 1px solid var(--line); padding: .78rem .85rem; color: var(--ink); background: var(--ground); }
input::placeholder, textarea::placeholder { color: var(--muted); opacity: .58; font-style: italic; }
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
.manual-recovery .form-action { justify-content: flex-start; flex-wrap: wrap; gap: .6rem; }
.setup-review { padding: 1rem; border: 1px solid var(--key); background: rgb(38 32 20 / 48%); }
.setup-review p { margin: 0 0 .65rem; }
.setup-review ul { display: grid; gap: .35rem; margin: .8rem 0 1rem; padding-left: 1.25rem; color: var(--muted); }
.setup-review .form-action { justify-content: flex-start; flex-wrap: wrap; gap: .6rem; }
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
#workspace-task-navigation { display: flex; flex-wrap: wrap; gap: .55rem; margin: 0 0 1rem; }
#workspace-task-navigation a { display: inline-flex; min-height: 2.75rem; align-items: center; padding: .55rem .85rem; color: var(--ink); background: var(--panel-raised); border: 1px solid var(--line); border-radius: .28rem; text-decoration: none; font-weight: 700; }
#workspace-task-navigation a:hover { border-color: var(--key); }
#workspace-task-navigation a[aria-selected="true"] { color: #19150d; background: var(--key); border-color: var(--key); }
#workspace-task-navigation a:focus-visible { outline: 2px solid var(--key); outline-offset: 2px; }
.workspace-task-panel[hidden] { display: none; }
#connection-overview, #connection-accounts, #connection-authentication, #connection-client-setup, #connection-audit { scroll-margin-top: 1rem; }
.summary article { display: flex; min-height: 9rem; flex-direction: column; gap: .45rem; padding: 1.25rem; background: var(--panel); }
.summary strong { font: 500 1.5rem/1.15 Georgia, serif; }
.summary span { color: var(--muted); font-size: .8rem; line-height: 1.45; }
.restart-note { margin: 1rem 0 4rem; padding: 1rem 1.2rem; border-left: .2rem solid var(--key); background: rgb(239 180 77 / 7%); }
.connection-list { display: grid; gap: .8rem; margin-bottom: 1.2rem; }
.configuration-catalog { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .8rem; }
.configuration-catalog-status { margin: 0 0 1rem; padding: .85rem 1rem; border: 1px solid var(--line); background: rgb(255 255 255 / 2%); }
.configuration-catalog-status p { margin: 0; }
.configuration-catalog-status ul { margin: .55rem 0 0; padding-left: 1.2rem; color: var(--muted); }
.configuration-catalog-status ul:empty { display: none; }
.catalog-actions { display: grid; gap: .8rem; justify-items: start; }
.catalog-actions p { margin: 0; }
.catalog-actions strong { color: var(--ink); }
.catalog-boundary { margin-top: 1rem; }
.configuration-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: center; padding: 1.15rem 1.25rem; border: 1px solid var(--line); background: var(--panel); }
.configuration-card p { margin: .25rem 0 0; font-size: .82rem; }
.configuration-card .configuration-meta { font: .73rem/1.5 ui-monospace, monospace; }
.configuration-profiles { display: flex; flex-wrap: wrap; gap: .4rem; margin: .75rem 0 0; padding: 0; list-style: none; }
.configuration-profiles li { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem; padding: .28rem .5rem; color: var(--ink); background: var(--ground); border: 1px solid var(--line); font: .72rem/1.35 ui-monospace, monospace; }
.configuration-profiles .configuration-default { border-color: var(--key); }
.configuration-profiles button { min-height: 2.75rem; padding: 0 .65rem; }
.configuration-card .configuration-switch { margin-top: .7rem; color: var(--ink); }
.configuration-card .configuration-switch-technical { color: var(--muted); font-size: .75rem; }
.configuration-card button { min-height: 2.75rem; font-size: .78rem; }
.provider-authentication { border-left: .2rem solid var(--safe); padding-left: 1.2rem; background: linear-gradient(90deg, rgb(117 201 154 / 7%), transparent 50%); }
.provider-authentication .section-heading { margin-bottom: 0; }
.setup-completion { border-left: .2rem solid var(--key); padding-left: 1.2rem; background: linear-gradient(90deg, rgb(239 180 77 / 7%), transparent 50%); }
.setup-completion-copy { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .85rem; max-width: 68rem; }
.setup-completion-copy article { padding: 1rem; border: 1px solid var(--line); background: var(--panel); }
.setup-completion-copy h3 { margin: 0 0 .75rem; }
.setup-completion-copy p { margin: .55rem 0 0; }
.setup-completion-client { grid-column: 1 / -1; }
.setup-completion-client textarea { margin-bottom: .65rem; }
.profile-readiness { border-left: .2rem solid var(--key); padding-left: 1.2rem; background: linear-gradient(90deg, rgb(239 180 77 / 7%), transparent 50%); }
.profile-readiness .input-row { max-width: 42rem; }
.profile-inventory-list { display: grid; gap: .65rem; }
.profile-inventory-item { display: grid; gap: .2rem; padding: .8rem 1rem; border: 1px solid var(--line); background: var(--panel); }
.profile-inventory-item p { margin: 0; color: var(--muted); font-size: .82rem; overflow-wrap: anywhere; }
.profile-inventory-item strong { overflow-wrap: anywhere; }
.connection { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem; align-items: center; padding: 1rem 1.2rem; border: 1px solid var(--line); background: var(--panel); }
.connection p { margin: .25rem 0 0; overflow-wrap: anywhere; font: .77rem/1.5 ui-monospace, monospace; }
.connection-actions { display: flex; flex-wrap: wrap; gap: .45rem; justify-content: flex-end; }
.connection-actions button { min-height: 2.35rem; font-size: .76rem; }
details { border: 1px solid var(--line); padding: 1rem; }
summary { cursor: pointer; font-weight: 700; }
.split { display: grid; grid-template-columns: minmax(0, .8fr) minmax(20rem, 1.2fr); gap: clamp(2rem, 6vw, 5rem); }
.audit-list { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.audit-list li { display: grid; grid-template-columns: 10rem 1fr auto; gap: 1rem; padding: .8rem 0; border-bottom: 1px solid var(--line); color: var(--muted); font: .76rem/1.45 ui-monospace, monospace; }
.status { position: sticky; bottom: 1rem; min-height: 1.5rem; width: fit-content; max-width: 100%; margin: 1rem 0 0; padding: .7rem 1rem; color: var(--ink); background: #222923; border: 1px solid var(--line); box-shadow: 0 .7rem 2rem rgb(0 0 0 / 35%); }
.status:empty { visibility: hidden; }
@media (max-width: 850px) { .mode-grid, .summary, .configuration-catalog { grid-template-columns: repeat(2, 1fr); } .section-heading, .split { grid-template-columns: 1fr; gap: 1rem; } }
@media (max-width: 620px) { .gate, .form-grid, .mode-grid, .summary, .configuration-catalog, .setup-completion-copy { grid-template-columns: 1fr; } .wide, .setup-completion-client { grid-column: 1; } .masthead { flex-direction: column; } .input-row, .connection, .configuration-card { align-items: stretch; flex-direction: column; grid-template-columns: 1fr; } .connection-actions { justify-content: flex-start; } .audit-list li { grid-template-columns: 1fr; gap: .2rem; } }
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
  const presetOnboardingView = byId("preset-onboarding-view");
  const clientEntryOnboardingView = byId("client-entry-onboarding-view");
  const workspaceView = byId("workspace-view");
  const workspaceTaskNavigation = byId("workspace-task-navigation");
  const workspaceTaskPanels = [
    byId("connection-overview"),
    byId("connection-accounts"),
    byId("connection-authentication"),
    byId("connection-client-setup"),
    byId("connection-audit")
  ].filter((panel) => panel instanceof HTMLElement);
  const configurationCatalogView = byId("configuration-catalog-view");
  const configurationCatalog = byId("configuration-catalog");
  const configurationCatalogSummary = byId("configuration-catalog-summary");
  const configurationCatalogAttention = byId("configuration-catalog-attention");
  const configurationCatalogRejectedGuidance = byId("configuration-catalog-rejected-guidance");
  const catalogClientSelect = byId("catalog-client-select");
  const catalogSwitchGuidance = byId("catalog-switch-guidance");
  let catalogSwitchButtons = [];
  let catalogSwitchUnavailableCount = 0;
  const setUpAnotherMcp = byId("set-up-another-mcp");
  const setupWizardView = byId("setup-wizard-view");
  const setupWizardStep = byId("setup-wizard-step");
  const setupWizardTitle = byId("setup-wizard-title");
  const setupWizardCopy = byId("setup-wizard-copy");
  const setupSourceChoice = byId("setup-source-choice");
  const setupWizardBack = byId("setup-wizard-back");
  const setupWizardCancel = byId("setup-wizard-cancel");
  const setupWizardContinue = byId("setup-wizard-continue");
  const setupDraftActions = byId("setup-draft-actions");
  const setupCompletionView = byId("setup-completion-view");
  const setupCompletionCreated = byId("setup-completion-created");
  const setupCompletionVerification = byId("setup-completion-verification");
  const setupCompletionNextAction = byId("setup-completion-next-action");
  const setupCompletionEnvironment = byId("setup-completion-environment");
  const setupCompletionHandoff = byId("setup-completion-handoff");
  const setupCompletionClientSelect = byId("setup-completion-client-select");
  const setupCompletionGenerateEntry = byId("setup-completion-generate-entry");
  const setupCompletionClientTarget = byId("setup-completion-client-target");
  const setupCompletionClientJson = byId("setup-completion-client-json");
  const setupCompletionClientGuidance = byId("setup-completion-client-guidance");
  const setupCompletionCopyJson = byId("setup-completion-copy-json");
  const setupCompletionSecondAccount = byId("setup-completion-second-account");
  const setupCompletionSwitch = byId("setup-completion-switch");
  const providerAuthenticationView = byId("provider-authentication-view");
  const providerAuthenticationCopy = byId("provider-authentication-copy");
  const providerAccountEditor = byId("provider-account-editor");
  const providerAccountCredentialLabel = byId("provider-account-credential-label");
  const providerAccountCredentialFile = byId("provider-account-credential-file");
  const environmentProfileEditor = byId("environment-profile-editor");
  const environmentProfileCredentialLabel = byId("environment-profile-credential-label");
  const environmentProfileCredentialEnv = byId("environment-profile-credential-env");
  const nativeOAuthEditor = byId("native-oauth-editor");
  const nativeOAuthAccountEditor = byId("native-oauth-account-editor");
  const presetReviewView = byId("preset-review-view");
  const presetReviewSummary = byId("preset-review-summary");
  const presetReviewDetails = byId("preset-review-details");
  const presetCreateReviewed = byId("preset-create-reviewed");
  const presetReviewEdit = byId("preset-review-edit");
  const saveSetupDraft = byId("save-setup-draft");
  const resumeSetupDraft = byId("resume-setup-draft");
  const discardSetupDraft = byId("discard-setup-draft");
  const presetInputNames = Object.freeze({
    generic: ["credentialEnv"],
    "github": [],
    "sentry": [],
    "google-search-console": [],
    "generic-npx": ["credentialEnv", "npmPackage"],
    "generic-docker": ["credentialEnv", "dockerImage"],
    "local-stdio": ["credentialEnv", "localCommand", "args", "cwd", "acceptLocalCommand"],
    "streamable-http": ["credentialEnv", "url", "headerName", "headerPrefix"]
  });
  let csrfToken = "";
  let profileReadinessTargets = [];
  let profileReadinessGeneration = 0;
  let setupCompletion = undefined;
  let pendingSetupCompletion = undefined;
  let setupCompletionGeneration = 0;
  let setupRefreshGeneration = 0;
  let authenticationEpoch = 0;
  let sessionRecoveryGeneration = 0;
  let pendingPresetRequest = undefined;
  let presetReviewGeneration = 0;
  let presetCreateInFlight = false;
  let activeSetupDraft = undefined;
  let returningSetupVisible = false;
  let setupWizardSource = "connector";
  let profileSwitchingFromMcp = false;
  const staleAuthenticationRequestName = "MiftahStaleAuthenticationRequest";

  function message(text) {
    if (status && typeof text === "string") status.textContent = text;
  }

  function workspaceTaskIdFromHash(hash) {
    const taskId = typeof hash === "string" && hash.startsWith("#") ? hash.slice(1) : "";
    return workspaceTaskPanels.some((panel) => panel.id === taskId) ? taskId : "connection-overview";
  }

  function selectWorkspaceTask(taskId, updateHash) {
    if (!(workspaceTaskNavigation instanceof HTMLElement)) return;
    const selectedTaskId = workspaceTaskIdFromHash("#" + taskId);
    const tabs = [...workspaceTaskNavigation.querySelectorAll("a[data-workspace-task]")];
    workspaceTaskPanels.forEach((panel) => {
      panel.hidden = panel.id !== selectedTaskId;
    });
    tabs.forEach((tab) => {
      const selected = tab.getAttribute("data-workspace-task") === selectedTaskId;
      tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("tabindex", selected ? "0" : "-1");
    });
    if (updateHash === true && typeof history !== "undefined") {
      history.replaceState(null, "", "#" + selectedTaskId);
    }
  }

  function initializeWorkspaceTaskNavigation() {
    if (!(workspaceTaskNavigation instanceof HTMLElement) || typeof window === "undefined") return;
    const tabs = [...workspaceTaskNavigation.querySelectorAll("a[data-workspace-task]")];
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", (event) => {
        event.preventDefault();
        selectWorkspaceTask(String(tab.getAttribute("data-workspace-task") || ""), true);
      });
      tab.addEventListener("keydown", (event) => {
        let targetIndex;
        if (event.key === "ArrowRight") targetIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") targetIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") targetIndex = 0;
        if (event.key === "End") targetIndex = tabs.length - 1;
        if (targetIndex === undefined) return;
        event.preventDefault();
        const target = tabs[targetIndex];
        if (!(target instanceof HTMLElement)) return;
        selectWorkspaceTask(String(target.getAttribute("data-workspace-task") || ""), true);
        target.focus();
      });
    });
    window.addEventListener("hashchange", () => {
      selectWorkspaceTask(workspaceTaskIdFromHash(window.location.hash), false);
    });
    selectWorkspaceTask(workspaceTaskIdFromHash(window.location.hash), false);
  }

  function staleAuthenticationRequestError() {
    const error = new Error("This response belongs to an earlier Console session.");
    error.name = staleAuthenticationRequestName;
    return error;
  }

  function isStaleAuthenticationRequest(error) {
    return error instanceof Error && error.name === staleAuthenticationRequestName;
  }

  function errorMessage(error) {
    if (isStaleAuthenticationRequest(error)) return undefined;
    return error instanceof Error ? error.message : "The Console request failed.";
  }

  function restoreUnlock(recoveryMessage) {
    authenticationEpoch += 1;
    sessionRecoveryGeneration += 1;
    csrfToken = "";
    returningSetupVisible = false;
    clearSetupCompletion();
    activeSetupDraft = undefined;
    renderSetupDraftControls();
    presetCreateInFlight = false;
    clearPresetReview();
    if (setupCompletionView) setupCompletionView.hidden = true;
    if (dashboardView) dashboardView.hidden = true;
    if (setupWizardView) setupWizardView.hidden = true;
    if (onboardingView) onboardingView.hidden = true;
    if (presetOnboardingView) presetOnboardingView.hidden = true;
    if (clientEntryOnboardingView) clientEntryOnboardingView.hidden = true;
    if (workspaceView) workspaceView.hidden = true;
    if (unlockView) unlockView.hidden = false;
    if (bootstrapInput instanceof HTMLInputElement) bootstrapInput.focus();
    if (typeof recoveryMessage === "string" && recoveryMessage.length > 0) message(recoveryMessage);
  }

  function sessionRecoveryMessage(code) {
    if (code === "session_missing") return "Enter the one-time code printed by the running Console process.";
    if (code === "session_expired") {
      return "This Console session expired before your next action. Run \`miftah dashboard\` in the terminal for a new one-time code.";
    }
    return "This page belongs to an earlier or different Console process. Run \`miftah dashboard\` in the terminal for a new URL and one-time code.";
  }

  function bootstrapRecoveryMessage(code) {
    if (code === "bootstrap_expired") {
      return "That one-time code expired. Run \`miftah dashboard\` in the terminal for a new code.";
    }
    if (code === "bootstrap_used") {
      return "That code already opened a browser session. Reload the original Console tab, or run \`miftah dashboard\` in the terminal for a new code.";
    }
    if (code === "bootstrap_superseded") {
      return "A newer one-time code was issued. Enter the latest code shown by the running Console process.";
    }
    if (code === "bootstrap_wrong_process") {
      return "That code belongs to another or stopped Console process. Run \`miftah dashboard\` in the terminal and use its new URL and code.";
    }
    return "Enter the complete one-time code exactly as printed by the running Console process.";
  }

  function bootstrapResponseError(response, payload) {
    const code = payload && payload.error && typeof payload.error.code === "string" ? payload.error.code : "";
    if (response.status === 401) return new Error(bootstrapRecoveryMessage(code));
    if (response.status === 429 && code === "rate_limit_exceeded") {
      const retryAfter = response.headers.get("retry-after");
      if (typeof retryAfter === "string" && /^[1-9][0-9]{0,2}$/.test(retryAfter)) {
        return new Error("Too many unlock attempts. Wait " + retryAfter + " seconds before trying again; keep this Console process running.");
      }
      return new Error("Too many unlock attempts. Wait briefly before trying again; keep this Console process running.");
    }
    const publicMessage = payload && payload.error && typeof payload.error.message === "string"
      ? payload.error.message
      : "The Console unlock request failed.";
    return new Error(publicMessage);
  }

  async function api(path, options) {
    const requestAuthenticationEpoch = authenticationEpoch;
    const request = options || {};
    const headers = { "Accept": "application/json" };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    if (request.method && request.method !== "GET" && request.method !== "HEAD") headers["X-Miftah-CSRF"] = csrfToken;
    let response;
    try {
      response = await fetch(path, {
        method: request.method || "GET",
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body)
      });
    } catch {
      if (requestAuthenticationEpoch !== authenticationEpoch) throw staleAuthenticationRequestError();
      const recovery = "This Console process is no longer reachable. Run \`miftah dashboard\` in the terminal for a new URL and one-time code.";
      restoreUnlock(recovery);
      throw new Error(recovery);
    }
    let payload;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (requestAuthenticationEpoch !== authenticationEpoch) throw staleAuthenticationRequestError();
    if (!response.ok) {
      if (response.status === 401) {
        const code = payload && payload.error && typeof payload.error.code === "string" ? payload.error.code : "";
        const recovery = sessionRecoveryMessage(code);
        restoreUnlock(recovery);
        throw new Error(recovery);
      }
      const publicMessage = payload && payload.error && typeof payload.error.message === "string"
        ? payload.error.message
        : "The Console request failed.";
      throw new Error(publicMessage);
    }
    return payload ? payload.data : undefined;
  }

  async function resumeSession() {
    const resumeAuthenticationEpoch = authenticationEpoch;
    let resumeMessageEpoch = resumeAuthenticationEpoch;
    message("Checking this browser session…");
    try {
      const resumed = record(await api("/api/v1/session"));
      if (authenticationEpoch !== resumeAuthenticationEpoch) return;
      if (typeof resumed.csrfToken !== "string" || resumed.csrfToken.length < 32) {
        throw new Error("Miftah did not return a valid session proof.");
      }
      authenticationEpoch += 1;
      resumeMessageEpoch = authenticationEpoch;
      csrfToken = resumed.csrfToken;
      await refreshAfterAuthentication();
    } catch (error) {
      if (authenticationEpoch === resumeMessageEpoch) message(errorMessage(error));
    }
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

  function googleSearchConsoleAccountRows() {
    const list = byId("gsc-account-list");
    if (!(list instanceof HTMLElement)) return [];
    return Array.from(list.querySelectorAll("[data-gsc-profile-row]")).filter((row) => row instanceof HTMLElement);
  }

  function googleSearchConsoleAccountInput(row, selector) {
    const input = row.querySelector(selector);
    return input instanceof HTMLInputElement ? input : undefined;
  }

  function syncGoogleSearchConsoleDefaultProfile() {
    const select = byId("gsc-default-profile");
    if (!(select instanceof HTMLSelectElement)) return;
    const previous = select.value;
    const names = googleSearchConsoleAccountRows()
      .map((row) => googleSearchConsoleAccountInput(row, "[data-gsc-profile-name]")?.value.trim() || "")
      .filter(Boolean);
    setOptions(select, [...new Set(names)]);
    if (names.includes(previous)) select.value = previous;
  }

  function googleSearchConsoleAccountLabel(text, input) {
    const label = document.createElement("label");
    label.textContent = text;
    label.append(input);
    return label;
  }

  function createGoogleSearchConsoleAccountRow(index) {
    const row = document.createElement("div");
    row.className = "gsc-account-row";
    row.dataset.gscProfileRow = "true";

    const profileName = document.createElement("input");
    profileName.type = "text";
    profileName.required = true;
    profileName.maxLength = 64;
    profileName.placeholder = "google-work";
    profileName.value = "google-account-" + String(index + 1);
    profileName.dataset.gscProfileName = "true";
    profileName.addEventListener("input", syncGoogleSearchConsoleDefaultProfile);

    const description = document.createElement("input");
    description.type = "text";
    description.maxLength = 1024;
    description.placeholder = "Work Google account";
    description.dataset.gscProfileDescription = "true";

    const clientSecrets = document.createElement("input");
    clientSecrets.type = "text";
    clientSecrets.required = true;
    clientSecrets.maxLength = 4096;
    clientSecrets.placeholder = "/Users/you/gsc-client-secrets.json";
    clientSecrets.dataset.gscClientSecretsFile = "true";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Remove account";
    remove.addEventListener("click", () => {
      row.remove();
      syncGoogleSearchConsoleDefaultProfile();
    });

    const action = document.createElement("div");
    action.className = "form-action";
    action.append(remove);
    row.append(
      googleSearchConsoleAccountLabel("Profile name", profileName),
      googleSearchConsoleAccountLabel("Description (optional)", description),
      googleSearchConsoleAccountLabel("Google OAuth client-secrets file", clientSecrets),
      action
    );
    return row;
  }

  function ensureGoogleSearchConsoleAccountRow() {
    const list = byId("gsc-account-list");
    if (!(list instanceof HTMLElement)) return;
    const rows = googleSearchConsoleAccountRows();
    if (rows.length === 0) list.append(createGoogleSearchConsoleAccountRow(0));
    syncGoogleSearchConsoleDefaultProfile();
  }

  function collectGoogleSearchConsoleProfiles() {
    const names = new Set();
    const profiles = googleSearchConsoleAccountRows().map((row) => {
      const name = googleSearchConsoleAccountInput(row, "[data-gsc-profile-name]")?.value.trim() || "";
      const description = googleSearchConsoleAccountInput(row, "[data-gsc-profile-description]")?.value.trim() || "";
      const oauthClientSecretsFile = googleSearchConsoleAccountInput(row, "[data-gsc-client-secrets-file]")?.value.trim() || "";
      if (!/^[a-z0-9](?:[a-z0-9-]{0,63})$/u.test(name)) {
        throw new Error("Each Google Search Console profile name must use lowercase letters, digits, or hyphens.");
      }
      if (names.has(name)) throw new Error("Each Google Search Console profile needs a unique name.");
      if (!oauthClientSecretsFile) throw new Error("Choose a Google OAuth client-secrets file for every account.");
      names.add(name);
      return {
        name,
        ...(description ? { description } : {}),
        oauthClientSecretsFile
      };
    });
    if (profiles.length === 0) throw new Error("Add at least one Google Search Console account.");
    return profiles;
  }

  function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function completionFromSetupResult(result, fallback = {}) {
    const setupResult = record(result);
    const completion = record(setupResult.completion);
    const safeFallback = record(fallback);
    const name = typeof setupResult.name === "string" ? setupResult.name : typeof safeFallback.name === "string" ? safeFallback.name : "";
    const defaultProfile = typeof setupResult.defaultProfile === "string"
      ? setupResult.defaultProfile
      : typeof setupResult.profile === "string"
        ? setupResult.profile
        : typeof safeFallback.defaultProfile === "string" ? safeFallback.defaultProfile : "";
    const profileCount = Number.isSafeInteger(setupResult.profileCount) && setupResult.profileCount > 0
      ? setupResult.profileCount
      : 1;
    return { ...completion, setup: { name, defaultProfile, profileCount } };
  }

  function selectedSetupCompletionClient() {
    const selected = setupCompletionClientSelect instanceof HTMLSelectElement
      ? setupCompletionClientSelect.value
      : "claude-desktop";
    return ["claude-desktop", "claude-code", "cursor", "vscode"].includes(selected)
      ? selected
      : "claude-desktop";
  }

  function renderSetupCompletionSwitch(setup) {
    if (!setupCompletionSwitch) return;
    const client = selectedSetupCompletionClient();
    setupCompletionSwitch.textContent =
      "After adding another account, return to Your MCP connections and use the named account action for " +
      catalogClientDisplayName(client) + ". Paste it into that chat; Console does not switch the running client session.";
  }

  function renderSetupCompletion(value) {
    const completion = record(value);
    const setup = record(completion.setup);
    const verification = record(completion.verification);
    const environment = record(completion.environment);
    const handoff = record(completion.clientHandoff);
    const verificationMessage = typeof verification.message === "string" ? verification.message : "";
    const nextAction = typeof verification.nextAction === "string" ? verification.nextAction : "";
    const environmentMessage = typeof environment.message === "string" ? environment.message : "";
    const environmentNextAction = typeof environment.nextAction === "string" ? environment.nextAction : "";
    const handoffMessage = typeof handoff.message === "string" ? handoff.message : "";
    const setupName = typeof setup.name === "string" ? setup.name : "";
    const defaultProfile = typeof setup.defaultProfile === "string" ? setup.defaultProfile : "";
    const profileCount = Number.isSafeInteger(setup.profileCount) ? setup.profileCount : 0;
    if (!setupName && !verificationMessage && !environmentMessage && !handoffMessage) {
      if (setupCompletionView) setupCompletionView.hidden = true;
      return;
    }
    if (setupCompletionCreated) {
      setupCompletionCreated.textContent = setupName
        ? "Created Miftah connection '" + setupName + "' with " + profileCount + " named account" + (profileCount === 1 ? "" : "s") +
          (defaultProfile ? "; default for new sessions: '" + defaultProfile + "'." : ".")
        : "The Miftah connection was created.";
    }
    const verificationState = typeof verification.state === "string" ? verification.state : "manual";
    if (setupCompletionVerification) {
      setupCompletionVerification.textContent = "Verification (" + verificationState + "): " + verificationMessage;
    }
    if (setupCompletionNextAction) {
      const safeAction = nextAction || (verificationState === "available"
        ? "Open Manage connection, choose Authentication, then run the reviewed safe check."
        : verificationState === "not-declared"
          ? "No automatic check is available. After client setup, use one provider-documented read-only action for manual verification."
          : "Complete the provider authorization or reported readiness step before treating the account as verified.");
      setupCompletionNextAction.textContent = safeAction;
      setupCompletionNextAction.hidden = !safeAction;
    }
    if (setupCompletionEnvironment) {
      const environmentState = typeof environment.state === "string" ? environment.state : "not-reported";
      setupCompletionEnvironment.textContent = "Secret readiness (" + environmentState + "): " +
        [environmentMessage, environmentNextAction].filter(Boolean).join(" ");
      setupCompletionEnvironment.hidden = !environmentMessage && !environmentNextAction;
    }
    if (setupCompletionHandoff) setupCompletionHandoff.textContent = handoffMessage;
    if (setupCompletionSecondAccount) {
      setupCompletionSecondAccount.textContent =
        "Open Manage connection, then choose Accounts or Authentication. Miftah shows only the supported way to add another named account for this connection.";
    }
    renderSetupCompletionSwitch(setup);
    if (setupCompletionView) {
      setupCompletionView.hidden = false;
      if (typeof setupCompletionView.scrollIntoView === "function") {
        setupCompletionView.scrollIntoView({ block: "start" });
      }
    }
    if (setupCompletionClientSelect instanceof HTMLSelectElement) {
      setupCompletionClientSelect.focus({ preventScroll: true });
    }
  }

  function replaceSetupCompletion(value) {
    setupCompletionGeneration += 1;
    setupCompletion = value;
    if (setupCompletionGenerateEntry instanceof HTMLButtonElement) {
      setupCompletionGenerateEntry.disabled = false;
    }
    renderSetupCompletion(setupCompletion);
  }

  function setupCompletionRequestIsCurrent(generation, client) {
    return generation === setupCompletionGeneration && client === selectedSetupCompletionClient();
  }

  function restorePendingSetupCompletion() {
    if (pendingSetupCompletion === undefined) return;
    const completion = pendingSetupCompletion;
    pendingSetupCompletion = undefined;
    replaceSetupCompletion(completion);
  }

  function resetAuthenticatedActionControls() {
    if (saveSetupDraft instanceof HTMLButtonElement) saveSetupDraft.disabled = false;
    if (resumeSetupDraft instanceof HTMLButtonElement) resumeSetupDraft.disabled = false;
    if (runProfileReadiness instanceof HTMLButtonElement) runProfileReadiness.disabled = false;
  }

  async function refreshAfterAuthentication() {
    const refreshAuthenticationEpoch = authenticationEpoch;
    const recoveryGeneration = sessionRecoveryGeneration;
    try {
      await refresh();
      if (authenticationEpoch === refreshAuthenticationEpoch && sessionRecoveryGeneration === recoveryGeneration) {
        resetAuthenticatedActionControls();
      }
    } finally {
      if (authenticationEpoch === refreshAuthenticationEpoch && sessionRecoveryGeneration === recoveryGeneration) {
        restorePendingSetupCompletion();
      }
    }
  }

  async function refreshAfterSetup(completion) {
    const setupAuthenticationEpoch = authenticationEpoch;
    const refreshGeneration = ++setupRefreshGeneration;
    pendingSetupCompletion = completion;
    try {
      await refresh();
    } catch (error) {
      if (authenticationEpoch !== setupAuthenticationEpoch || refreshGeneration !== setupRefreshGeneration) {
        if (isStaleAuthenticationRequest(error)) throw error;
        throw staleAuthenticationRequestError();
      }
      throw error;
    } finally {
      if (authenticationEpoch === setupAuthenticationEpoch && refreshGeneration === setupRefreshGeneration) {
        if (unlockView instanceof HTMLElement && !unlockView.hidden) {
          pendingSetupCompletion = completion;
        } else {
          pendingSetupCompletion = undefined;
          replaceSetupCompletion(completion);
        }
      }
    }
  }

  function clearSetupCompletion() {
    replaceSetupCompletion(undefined);
    if (setupCompletionClientTarget) setupCompletionClientTarget.textContent = "";
    if (setupCompletionClientJson instanceof HTMLTextAreaElement) setupCompletionClientJson.value = "";
    if (setupCompletionClientGuidance) setupCompletionClientGuidance.textContent = "";
    if (setupCompletionCopyJson instanceof HTMLButtonElement) setupCompletionCopyJson.disabled = true;
    renderSetupCompletion(undefined);
  }

  function catalogConfigurations(metadata) {
    const catalog = record(metadata.catalog);
    const configurations = Array.isArray(catalog.configurations) ? catalog.configurations.map(record) : [];
    const safeCount = (value, fallback) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
    const attentionReasons = Array.isArray(catalog.attentionReasons)
      ? catalog.attentionReasons.map(record).flatMap((item) => {
          const reason = typeof item.reason === "string" ? item.reason : "";
          const count = safeCount(item.count, 0);
          return count > 0 ? [{ reason, count }] : [];
        })
      : [];
    const attentionCount = safeCount(
      catalog.attentionCount,
      attentionReasons.reduce((total, item) => total + item.count, 0)
    );
    const readyCount = safeCount(catalog.readyCount, configurations.length);
    return {
      discoveryState: typeof catalog.discoveryState === "string" ? catalog.discoveryState : "",
      selectedConfigurationId: typeof catalog.selectedConfigurationId === "string" ? catalog.selectedConfigurationId : "",
      discoveredCount: safeCount(catalog.discoveredCount, readyCount + attentionCount),
      readyCount,
      attentionCount,
      attentionReasons,
      configurations
    };
  }

  function selectedCatalogClient() {
    const supported = ["claude-desktop", "claude-code", "cursor", "vscode"];
    const selected = catalogClientSelect instanceof HTMLSelectElement ? catalogClientSelect.value : "";
    return supported.includes(selected) ? selected : "claude-desktop";
  }

  function catalogClientDisplayName(client) {
    return {
      "claude-desktop": "Claude Desktop",
      "claude-code": "Claude Code",
      cursor: "Cursor",
      vscode: "VS Code"
    }[client] || "your MCP client";
  }

  function profileSwitchRequest(client, profile) {
    return "In " + catalogClientDisplayName(client) + ", send this message: Use the Miftah account named " + profile + " for this chat.";
  }

  function updateCatalogSwitchCopy() {
    const client = selectedCatalogClient();
    const clientName = catalogClientDisplayName(client);
    if (catalogSwitchGuidance) {
      const unavailableGuidance = catalogSwitchUnavailableCount > 0
        ? " Some connections do not support account switching in an active chat. Change their default account, then start a new MCP session."
        : "";
      catalogSwitchGuidance.textContent = catalogSwitchButtons.length > 0
        ? "Choose an account action below, then paste the copied request into " + clientName +
          ". It changes that chat only; Console does not switch the running client or change the default account. " +
          "Technical detail: the client can call miftah_use_profile." + unavailableGuidance
        : catalogSwitchUnavailableCount > 0
          ? "Account switching in an active chat is unavailable for these connections. Change the default account, then start a new MCP session."
          : "";
    }
    catalogSwitchButtons.forEach((button) => {
      if (!(button instanceof HTMLButtonElement)) return;
      const profile = button.dataset.copyProfileSwitch || "";
      button.setAttribute("aria-label", "Copy request to use " + profile + " in the current " + clientName + " chat");
    });
  }

  function renderConfigurationCatalog(metadata) {
    const catalog = catalogConfigurations(metadata);
    const hasCatalogState = catalog.discoveredCount > 0 || catalog.readyCount > 0 || catalog.attentionCount > 0;
    if (configurationCatalogView) configurationCatalogView.hidden = !hasCatalogState;
    if (setUpAnotherMcp) {
      setUpAnotherMcp.hidden = catalog.discoveryState !== "ready" || catalog.configurations.length === 0;
    }
    if (configurationCatalogSummary) {
      const connections = catalog.discoveredCount === 1 ? "MCP connection found" : "MCP connections found";
      const attention = catalog.attentionCount === 1 ? "needs attention" : "need attention";
      configurationCatalogSummary.textContent =
        catalog.discoveredCount + " " + connections + " · " +
        catalog.readyCount + " ready · " +
        catalog.attentionCount + " " + attention;
    }
    if (configurationCatalogRejectedGuidance) {
      configurationCatalogRejectedGuidance.hidden = catalog.attentionCount === 0;
    }
    if (configurationCatalogAttention) {
      configurationCatalogAttention.replaceChildren();
      const labels = {
        "file-permissions": "private file permission",
        "invalid-configuration": "invalid configuration",
        "unsafe-path": "unsafe path or file replacement",
        "duplicate": "duplicate file",
        "unreadable": "unreadable or changing file"
      };
      catalog.attentionReasons.forEach((item) => {
        const label = labels[item.reason];
        if (typeof label !== "string") return;
        const entry = document.createElement("li");
        entry.textContent = item.count + " " + label + (item.count === 1 ? "" : "s");
        configurationCatalogAttention.append(entry);
      });
    }
    if (!configurationCatalog) return catalog;
    configurationCatalog.replaceChildren();
    catalogSwitchButtons = [];
    catalogSwitchUnavailableCount = 0;
    catalog.configurations.forEach((configuration) => {
      const id = typeof configuration.id === "string" ? configuration.id : "";
      const card = document.createElement("article");
      card.className = "configuration-card";
      const details = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = typeof configuration.name === "string" ? configuration.name : "Unnamed configuration";
      const summary = document.createElement("p");
      const profileCount = typeof configuration.profileCount === "number" ? configuration.profileCount : 0;
      const defaultProfile = typeof configuration.defaultProfile === "string" ? configuration.defaultProfile : "unknown";
      summary.textContent = "Default account for new MCP sessions: " + defaultProfile;
      const configuredProfileNames = Array.isArray(configuration.profileNames)
        ? configuration.profileNames.filter((profile) => typeof profile === "string")
        : [];
      const profileNames = configuredProfileNames.length > 0
        ? configuredProfileNames
        : defaultProfile === "unknown" ? [] : [defaultProfile];
      const profileList = document.createElement("ul");
      profileList.className = "configuration-profiles";
      const visibleProfileCount = profileNames.length > 0 ? profileNames.length : profileCount;
      profileList.setAttribute("aria-label", visibleProfileCount + " named account profile" + (visibleProfileCount === 1 ? "" : "s"));
      profileNames.forEach((profile) => {
        const item = document.createElement("li");
        const profileName = document.createElement("span");
        profileName.textContent = profile + (profile === defaultProfile ? " · default" : "");
        item.append(profileName);
        if (profile === defaultProfile) item.className = "configuration-default";
        if (configuration.profileSwitchingFromMcp === true) {
          const copySwitchRequest = document.createElement("button");
          copySwitchRequest.type = "button";
          copySwitchRequest.className = "secondary";
          copySwitchRequest.dataset.copyProfileSwitch = profile;
          copySwitchRequest.textContent = "Use " + profile + " in this chat";
          copySwitchRequest.addEventListener("click", async () => {
            const client = selectedCatalogClient();
            try {
              await navigator.clipboard.writeText(profileSwitchRequest(client, profile));
              message(
                "Copied a request to use " + profile + " in " + catalogClientDisplayName(client) +
                ". Paste it into the chat where Miftah is connected."
              );
            } catch {
              message("Clipboard access was unavailable. Copy this request manually: " + profileSwitchRequest(client, profile));
            }
          });
          catalogSwitchButtons.push(copySwitchRequest);
          item.append(copySwitchRequest);
        }
        profileList.append(item);
      });
      const ownership = document.createElement("p");
      ownership.className = "configuration-meta";
      const authentication = record(configuration.authentication);
      ownership.textContent = authentication.mode === "provider-adapter"
        ? "provider-owned authentication"
        : authentication.mode === "miftah-native-oauth"
          ? "Miftah-managed native OAuth available"
          : "manual upstream authentication required";
      details.append(title, summary, profileList);
      if (configuration.profileSwitchingFromMcp !== true) {
        catalogSwitchUnavailableCount += 1;
      }
      details.append(ownership);
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.configuration = id;
      const selected = id.length > 0 && id === catalog.selectedConfigurationId;
      button.textContent = selected ? "Open now" : "Manage connection";
      button.className = selected ? "secondary" : "";
      button.disabled = !id || selected;
      card.append(details, button);
      configurationCatalog.append(card);
    });
    if (catalogSwitchGuidance) {
      catalogSwitchGuidance.hidden = catalogSwitchButtons.length === 0 && catalogSwitchUnavailableCount === 0;
    }
    updateCatalogSwitchCopy();
    return catalog;
  }

  if (catalogClientSelect instanceof HTMLSelectElement) {
    catalogClientSelect.addEventListener("change", updateCatalogSwitchCopy);
  }

  function renderProviderAuthentication(value) {
    const authentication = record(value);
    const providerAdapter = authentication.mode === "provider-adapter";
    const manualOnly = authentication.mode === "manual-only";
    const nativeOAuth = authentication.mode === "miftah-native-oauth";
    const accountAddition = record(authentication.accountAddition);
    const environmentProfileAddition = record(authentication.environmentProfileAddition);
    const credentialFileLabel = typeof accountAddition.credentialFileLabel === "string"
      ? accountAddition.credentialFileLabel
      : "";
    const credentialFilePlaceholder = typeof accountAddition.credentialFilePlaceholder === "string"
      ? accountAddition.credentialFilePlaceholder
      : "";
    const providerAccount = providerAdapter && credentialFileLabel.length > 0 && credentialFilePlaceholder.length > 0;
    const credentialEnvironment = typeof environmentProfileAddition.credentialEnvironment === "string"
      ? environmentProfileAddition.credentialEnvironment
      : "";
    const environmentProfile = manualOnly && credentialEnvironment.length > 0;
    if (providerAuthenticationView) providerAuthenticationView.hidden = !providerAdapter && !manualOnly;
    if (providerAccountEditor) providerAccountEditor.hidden = !providerAccount;
    if (environmentProfileEditor) environmentProfileEditor.hidden = !environmentProfile;
    if (providerAccountCredentialLabel) {
      providerAccountCredentialLabel.textContent = providerAccount ? credentialFileLabel : "Provider credential-file path";
    }
    if (providerAccountCredentialFile instanceof HTMLInputElement) {
      providerAccountCredentialFile.placeholder = providerAccount ? credentialFilePlaceholder : "";
      if (!providerAccount) providerAccountCredentialFile.value = "";
    }
    if (environmentProfileCredentialLabel) {
      environmentProfileCredentialLabel.textContent = environmentProfile
        ? "Environment variable that holds this account's credential for " + credentialEnvironment
        : "Environment variable that holds this account's credential";
    }
    if (environmentProfileCredentialEnv instanceof HTMLInputElement && !environmentProfile) {
      environmentProfileCredentialEnv.value = "";
    }
    if (nativeOAuthEditor) nativeOAuthEditor.hidden = !nativeOAuth;
    if (nativeOAuthAccountEditor) nativeOAuthAccountEditor.hidden = !nativeOAuth;
    if (!providerAuthenticationCopy) return;
    if (manualOnly) {
      providerAuthenticationCopy.textContent = environmentProfile
        ? "This local MCP uses one environment credential binding. Add another named account by choosing a different environment variable; Miftah stores only that reference and does not launch the upstream."
        : "This configuration includes local upstream settings outside Miftah's reviewed adapter envelope. Miftah will not take over OAuth here; use each upstream's documented authentication setup.";
      return;
    }
    if (!providerAdapter) return;
    const provider = typeof authentication.provider === "string" ? authentication.provider : "This provider";
    const reauthOwner = authentication.reauthOwner === "upstream" ? "Use the provider adapter's documented reauthentication tool when needed."
      : "Use the provider's documented reauthentication flow when needed.";
    const disconnectOwner = authentication.disconnectOwner === "manual-only"
      ? " Revoke access from the provider console; Miftah does not remove or inspect the provider cache."
      : " Miftah only manages the boundaries declared by this adapter.";
    providerAuthenticationCopy.textContent = "This provider owns its browser login and private token cache. " + provider + " keeps OAuth outside Miftah. " + reauthOwner + disconnectOwner;
  }

  function configuredProfileReadinessTargets(authentication) {
    const targets = record(authentication).readinessTargets;
    if (!Array.isArray(targets)) return [];
    return targets.map(record).flatMap((target) => {
      const profile = typeof target.profile === "string" ? target.profile : "";
      const upstream = typeof target.upstream === "string" ? target.upstream : "";
      return profile && upstream ? [{ profile, upstream }] : [];
    });
  }

  function clearProfileReadinessResult() {
    profileReadinessGeneration += 1;
    const result = byId("profile-readiness-result");
    if (result) result.textContent = "";
  }

  function syncProfileReadinessUpstreams(preferredUpstream) {
    clearProfileReadinessResult();
    const profile = byId("profile-readiness-profile");
    const upstream = byId("profile-readiness-upstream");
    if (!(profile instanceof HTMLSelectElement) || !(upstream instanceof HTMLSelectElement)) return;
    const values = profileReadinessTargets
      .filter((target) => target.profile === profile.value)
      .map((target) => target.upstream);
    setOptions(upstream, values);
    if (typeof preferredUpstream === "string" && values.includes(preferredUpstream)) upstream.value = preferredUpstream;
  }

  function renderProfileReadiness(authentication, defaultProfile) {
    const view = byId("profile-readiness-view");
    clearProfileReadinessResult();
    profileReadinessTargets = configuredProfileReadinessTargets(authentication);
    if (view) view.hidden = profileReadinessTargets.length === 0;
    const profile = byId("profile-readiness-profile");
    const upstream = byId("profile-readiness-upstream");
    if (profileReadinessTargets.length === 0) {
      setOptions(profile, []);
      setOptions(upstream, []);
      return;
    }
    const profiles = [...new Set(profileReadinessTargets.map((target) => target.profile))];
    setOptions(profile, profiles);
    if (profile instanceof HTMLSelectElement && profiles.includes(defaultProfile)) profile.value = defaultProfile;
    syncProfileReadinessUpstreams();
  }

  function renderDefaultProfileEditor(profiles, defaultProfile) {
    const editor = byId("default-profile-editor");
    const profile = byId("default-profile-selection");
    const button = byId("set-default-profile");
    const result = byId("default-profile-result");
    if (!(profile instanceof HTMLSelectElement)) return;
    setOptions(profile, profiles);
    if (profiles.includes(defaultProfile)) profile.value = defaultProfile;
    const canChange = profiles.length > 1;
    profile.disabled = !canChange;
    if (button instanceof HTMLButtonElement) button.disabled = !canChange;
    if (editor) editor.hidden = !canChange;
    if (result) result.textContent = "";
  }

  function renderProfileDescriptionEditor(profileMetadata) {
    const editor = byId("profile-description-editor");
    const profile = byId("profile-description-selection");
    const input = byId("profile-description-input");
    const save = byId("set-profile-description");
    const clear = byId("clear-profile-description");
    const result = byId("profile-description-result");
    if (!(profile instanceof HTMLSelectElement) || !(input instanceof HTMLInputElement)) return;
    const previouslySelected = profile.value;
    const profiles = Array.isArray(profileMetadata) ? profileMetadata.map(record) : [];
    const names = profiles.map((item) => typeof item.name === "string" ? item.name : "").filter(Boolean);
    setOptions(profile, names);
    if (names.includes(previouslySelected)) profile.value = previouslySelected;
    const canChange = names.length > 0;
    const updateDescription = () => {
      const selected = profiles.find((item) => item.name === profile.value);
      input.value = selected && typeof selected.description === "string" ? selected.description : "";
    };
    profile.disabled = !canChange;
    input.disabled = !canChange;
    if (save instanceof HTMLButtonElement) save.disabled = !canChange;
    if (clear instanceof HTMLButtonElement) clear.disabled = !canChange;
    if (editor) editor.hidden = !canChange;
    if (result) result.textContent = "";
    profile.onchange = updateDescription;
    updateDescription();
  }

  function renderProfileRenameEditor(profiles, defaultProfile) {
    const editor = byId("profile-rename-editor");
    const profile = byId("profile-rename-selection");
    const input = byId("profile-rename-input");
    const button = byId("rename-profile");
    const result = byId("profile-rename-result");
    if (!(profile instanceof HTMLSelectElement) || !(input instanceof HTMLInputElement)) return;
    const previousProfile = profile.value;
    setOptions(profile, profiles);
    if (profiles.includes(previousProfile)) profile.value = previousProfile;
    else if (profiles.includes(defaultProfile)) profile.value = defaultProfile;
    const canRename = profiles.length > 0;
    profile.disabled = !canRename;
    input.disabled = !canRename;
    if (button instanceof HTMLButtonElement) button.disabled = !canRename;
    if (editor) editor.hidden = !canRename;
    if (result) result.textContent = "";
    profile.onchange = () => {
      input.value = "";
      if (result) result.textContent = "";
    };
  }

  function renderProfileRemovalEditor(profiles, defaultProfile) {
    const editor = byId("profile-removal-editor");
    const profile = byId("profile-removal-selection");
    const replacement = byId("profile-removal-replacement");
    const confirmation = byId("confirm-profile-removal");
    const button = byId("remove-profile");
    const result = byId("profile-removal-result");
    if (!(profile instanceof HTMLSelectElement) || !(replacement instanceof HTMLSelectElement)) return;
    const previousProfile = profile.value;
    const previousReplacement = replacement.value;
    const canRemove = profiles.length > 1;
    setOptions(profile, profiles);
    if (profiles.includes(previousProfile)) profile.value = previousProfile;
    else if (profiles.includes(defaultProfile) && profiles.length > 1) {
      profile.value = profiles.find((name) => name !== defaultProfile) || defaultProfile;
    }
    const syncReplacement = () => {
      const currentReplacement = replacement.value;
      const choices = profiles.filter((name) => name !== profile.value);
      setOptions(replacement, choices);
      if (choices.includes(currentReplacement)) replacement.value = currentReplacement;
      else if (choices.includes(previousReplacement)) replacement.value = previousReplacement;
      else if (choices.includes(defaultProfile)) replacement.value = defaultProfile;
      if (confirmation instanceof HTMLInputElement) confirmation.checked = false;
    };
    profile.disabled = !canRemove;
    replacement.disabled = !canRemove;
    if (confirmation instanceof HTMLInputElement) confirmation.disabled = !canRemove;
    if (button instanceof HTMLButtonElement) button.disabled = !canRemove;
    if (editor) editor.hidden = !canRemove;
    if (result) result.textContent = "";
    profile.onchange = syncReplacement;
    syncReplacement();
  }

  function renderProfileInventory(value, defaultProfile) {
    const list = byId("profile-inventory-list");
    if (!list) return;
    list.replaceChildren();
    const profiles = Array.isArray(value) ? value.map(record) : [];
    if (profiles.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No configured accounts are available.";
      list.append(empty);
      return;
    }
    profiles.forEach((profile) => {
      const name = typeof profile.name === "string" ? profile.name : "Unnamed profile";
      const item = document.createElement("article");
      item.className = "profile-inventory-item";
      const title = document.createElement("strong");
      title.textContent = name + (name === defaultProfile ? " · durable default" : "");
      item.append(title);
      if (typeof profile.description === "string" && profile.description) {
        const description = document.createElement("p");
        description.textContent = profile.description;
        item.append(description);
      }
      const tags = Array.isArray(profile.tags) ? profile.tags.filter((tag) => typeof tag === "string") : [];
      const policy = typeof profile.policy === "string" ? profile.policy : "";
      const upstreams = Array.isArray(profile.upstreams) ? profile.upstreams.filter((upstream) => typeof upstream === "string") : [];
      const details = [
        tags.length > 0 ? "tags: " + tags.join(", ") : "",
        policy ? "policy: " + policy : "",
        upstreams.length > 0 ? "overrides: " + upstreams.join(", ") : ""
      ].filter(Boolean);
      if (details.length > 0) {
        const detail = document.createElement("p");
        detail.textContent = details.join(" · ");
        item.append(detail);
      }
      list.append(item);
    });
  }

  function profileReadinessMessage(value) {
    const report = record(value);
    const profile = typeof report.profile === "string" ? report.profile : "selected profile";
    const safeRead = record(report.safeRead);
    const tool = typeof safeRead.tool === "string" ? safeRead.tool : "the provider-declared read-only tool";
    const errorCode = typeof safeRead.errorCode === "string" ? " (" + safeRead.errorCode + ")" : "";
    if (report.status === "ready") return "Reviewed safe check completed for " + profile + " using " + tool + ".";
    if (report.status === "confirmation-required") return "Miftah did not call the provider because this check requires confirmation" + errorCode + ".";
    if (report.status === "identity-failed") return "Miftah did not complete the check because identity verification failed" + errorCode + ".";
    if (report.status === "unsupported") return "This profile has no provider-declared safe check" + errorCode + ".";
    return "Miftah did not complete the reviewed safe check" + errorCode + ".";
  }

  function renderConnections(value, authentication) {
    const list = byId("connection-list");
    if (!list) return;
    list.replaceChildren();
    const connections = Array.isArray(value) ? value : [];
    if (connections.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = record(authentication).mode === "provider-adapter"
        ? "This provider manages its OAuth state outside Miftah; no native OAuth binding is configured here."
        : record(authentication).mode === "manual-only"
          ? "This configuration uses upstream-managed authentication. Miftah has no native OAuth binding to manage here."
          : "No native OAuth connections are configured yet.";
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
      const statusErrorCode = typeof connection.statusErrorCode === "string" ? connection.statusErrorCode : "";
      state.textContent = statusErrorCode
        ? "status unavailable: " + statusErrorCode
        : "credential: " + credential + " · identity: " + identity;
      const binding = document.createElement("p");
      const resource = typeof connection.resource === "string" ? connection.resource : "unknown resource";
      const issuer = typeof connection.issuer === "string" ? connection.issuer : "unknown issuer";
      const grantedScopes = Array.isArray(connection.scopes) ? connection.scopes.map(String).join(" ") : "none";
      binding.textContent = "resource: " + resource + " · issuer: " + issuer + " · scopes: " + (grantedScopes || "none");
      details.append(title, binding, state);
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

  function updatePresetFields() {
    const form = byId("preset-onboarding-form");
    const selection = byId("preset-selection");
    if (!(form instanceof HTMLFormElement) || !(selection instanceof HTMLSelectElement)) return;
    const preset = selection.value;
    form.querySelectorAll("[data-preset-field]").forEach((field) => {
      if (!(field instanceof HTMLElement)) return;
      const visible = (field.dataset.presetField || "").split(" ").includes(preset);
      field.hidden = !visible;
      field.querySelectorAll("input, select, textarea").forEach((control) => {
        if (
          !(control instanceof HTMLInputElement) &&
          !(control instanceof HTMLSelectElement) &&
          !(control instanceof HTMLTextAreaElement)
        ) return;
        control.disabled = !visible;
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
          control.required = visible && (
            (control.name === "npmPackage" && preset === "generic-npx") ||
            (control.name === "dockerImage" && preset === "generic-docker") ||
            (control.name === "localCommand" && preset === "local-stdio") ||
            (control.name === "acceptLocalCommand" && preset === "local-stdio") ||
            (control.name === "url" && preset === "streamable-http") ||
            (preset === "google-search-console" && (
              control.dataset.gscProfileName === "true" || control.dataset.gscClientSecretsFile === "true"
            ))
          );
          return;
        }
        control.required = visible && preset === "google-search-console" && control.id === "gsc-default-profile";
      });
    });
    if (preset === "google-search-console") ensureGoogleSearchConsoleAccountRow();
  }

  function renderSetupDraftControls() {
    if (discardSetupDraft instanceof HTMLButtonElement) {
      discardSetupDraft.hidden = activeSetupDraft === undefined;
      discardSetupDraft.disabled = activeSetupDraft === undefined;
    }
  }

  function setupDraftIntent() {
    const form = byId("preset-onboarding-form");
    const selection = byId("preset-selection");
    const name = form instanceof HTMLFormElement ? form.querySelector("input[name='name']") : undefined;
    if (!(name instanceof HTMLInputElement) || !(selection instanceof HTMLSelectElement)) {
      throw new Error("The connector setup form is unavailable.");
    }
    const configurationName = name.value.trim();
    const preset = selection.value;
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,63})?$/u.test(configurationName)) {
      throw new Error("Use a lowercase configuration name of up to 64 letters, numbers, dots, underscores, or hyphens before saving.");
    }
    if (!Object.prototype.hasOwnProperty.call(presetInputNames, preset)) {
      throw new Error("Choose a supported MCP option before saving.");
    }
    return {
      source: "connector",
      name: configurationName,
      preset,
      stage: "connection",
      expectedRevision: activeSetupDraft === undefined ? 0 : activeSetupDraft.revision
    };
  }

  function restoreSetupDraft(value) {
    const draft = record(value);
    const allowedFields = new Set(["schemaVersion", "revision", "source", "name", "preset", "stage", "savedAt"]);
    if (
      Object.keys(draft).length !== allowedFields.size ||
      Object.keys(draft).some((field) => !allowedFields.has(field)) ||
      draft.schemaVersion !== 1 ||
      !Number.isSafeInteger(draft.revision) || draft.revision < 1 ||
      draft.source !== "connector" ||
      typeof draft.name !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,63})?$/u.test(draft.name) ||
      typeof draft.preset !== "string" || !Object.prototype.hasOwnProperty.call(presetInputNames, draft.preset) ||
      draft.stage !== "connection" ||
      typeof draft.savedAt !== "string"
    ) {
      throw new Error("Miftah did not return a safe saved MCP choice.");
    }
    const form = byId("preset-onboarding-form");
    const selection = byId("preset-selection");
    const name = form instanceof HTMLFormElement ? form.querySelector("input[name='name']") : undefined;
    if (!(form instanceof HTMLFormElement) || !(selection instanceof HTMLSelectElement) || !(name instanceof HTMLInputElement)) {
      throw new Error("The connector setup form is unavailable.");
    }
    form.reset();
    const accounts = byId("gsc-account-list");
    if (accounts instanceof HTMLElement) accounts.replaceChildren();
    activeSetupDraft = {
      schemaVersion: 1,
      revision: draft.revision,
      source: "connector",
      name: draft.name,
      preset: draft.preset,
      stage: "connection",
      savedAt: draft.savedAt
    };
    name.value = activeSetupDraft.name;
    selection.value = activeSetupDraft.preset;
    updateSetupSourceChoice("connector");
    updatePresetFields();
    clearPresetReview();
    renderSetupDraftControls();
  }

  function setPresetReviewActionsDisabled(disabled) {
    if (presetCreateReviewed instanceof HTMLButtonElement) presetCreateReviewed.disabled = disabled;
    if (presetReviewEdit instanceof HTMLButtonElement) presetReviewEdit.disabled = disabled;
  }

  function clearPresetReview() {
    presetReviewGeneration += 1;
    pendingPresetRequest = undefined;
    if (presetReviewView instanceof HTMLElement) presetReviewView.hidden = true;
    if (presetReviewSummary instanceof HTMLElement) presetReviewSummary.textContent = "";
    if (presetReviewDetails instanceof HTMLElement) presetReviewDetails.replaceChildren();
    if (presetCreateReviewed instanceof HTMLButtonElement) presetCreateReviewed.disabled = true;
    if (presetReviewEdit instanceof HTMLButtonElement) presetReviewEdit.disabled = presetCreateInFlight;
  }

  function renderPresetReview(value) {
    const review = record(value);
    const configuration = record(review.configuration);
    if (configuration.sensitiveValues !== "omitted" || configuration.publication !== "new-file-only") {
      throw new Error("Miftah did not return a safe configuration review.");
    }
    const profiles = Array.isArray(configuration.profiles)
      ? configuration.profiles.filter((profile) => typeof profile === "string")
      : [];
    const upstreams = Array.isArray(configuration.upstreams) ? configuration.upstreams.map(record) : [];
    const profileCount = profiles.length;
    if (Object.prototype.hasOwnProperty.call(configuration, "profileCount") && configuration.profileCount !== profileCount) {
      throw new Error("Miftah did not return a safe configuration review.");
    }
    const name = typeof configuration.name === "string" ? configuration.name : "this configuration";
    const defaultProfile = typeof configuration.defaultProfile === "string" ? configuration.defaultProfile : "not set";
    if (presetReviewSummary instanceof HTMLElement) {
      presetReviewSummary.textContent = "Miftah will create '" + name + "' with " + profileCount + " account profile(s).";
    }
    if (presetReviewDetails instanceof HTMLElement) {
      presetReviewDetails.replaceChildren();
      [
        "Durable default profile: " + defaultProfile,
        "Profiles: " + (profiles.length > 0 ? profiles.join(", ") : "none"),
        "Upstreams: " + (upstreams.length > 0
          ? upstreams.map((upstream) => {
              const upstreamName = typeof upstream.name === "string" ? upstream.name : "default";
              const kind = typeof upstream.kind === "string" ? upstream.kind : "configured upstream";
              const transport = typeof upstream.transport === "string" ? upstream.transport : "unknown transport";
              return upstreamName + " — " + kind + " (" + transport + ")";
            }).join("; ")
          : "none"),
        "Publication: a new configuration file only; existing files are never replaced."
      ].forEach((text) => {
        const item = document.createElement("li");
        item.textContent = text;
        presetReviewDetails.append(item);
      });
    }
    if (presetReviewView instanceof HTMLElement) presetReviewView.hidden = false;
    setPresetReviewActionsDisabled(presetCreateInFlight);
  }

  function presetOnboardingRequest(form) {
    const data = new FormData(form);
    const request = {
      name: String(data.get("name") || "").trim(),
      preset: String(data.get("preset") || "")
    };
    const preset = request.preset;
    const allowedNames = presetInputNames[preset] || [];
    if (preset === "google-search-console") {
      const googleSearchConsoleProfiles = collectGoogleSearchConsoleProfiles();
      const defaultProfile = String(data.get("defaultProfile") || "").trim();
      if (!googleSearchConsoleProfiles.some((profile) => profile.name === defaultProfile)) {
        throw new Error("Choose one of the configured Google Search Console accounts as the default.");
      }
      request.googleSearchConsoleProfiles = googleSearchConsoleProfiles;
      request.defaultProfile = defaultProfile;
    } else if (preset === "local-stdio") {
      const localCommand = String(data.get("localCommand") || "").trim();
      const argumentText = String(data.get("args") || "");
      const cwd = String(data.get("cwd") || "").trim();
      const credentialEnv = String(data.get("credentialEnv") || "").trim();
      request.localCommand = localCommand;
      request.args = argumentText === "" ? [] : argumentText.split(/\\r?\\n/u);
      request.acceptLocalCommand = data.get("acceptLocalCommand") === "true";
      if (cwd) request.cwd = cwd;
      if (credentialEnv) request.credentialEnv = credentialEnv;
    } else {
      ["credentialEnv", "npmPackage", "dockerImage", "url", "headerName", "oauthClientSecretsFile"].forEach((name) => {
        if (!allowedNames.includes(name)) return;
        const value = String(data.get(name) || "").trim();
        if (value) request[name] = value;
      });
      const headerPrefix = String(data.get("headerPrefix") || "");
      if (allowedNames.includes("headerPrefix") && headerPrefix.trim()) request.headerPrefix = headerPrefix.trimStart();
    }
    return request;
  }

  function updateSetupSourceChoice(source) {
    if (!(setupSourceChoice instanceof HTMLElement)) return;
    setupSourceChoice.querySelectorAll("input[data-setup-source]").forEach((input) => {
      if (!(input instanceof HTMLInputElement)) return;
      input.checked = input.dataset.setupSource === source;
    });
  }

  function hideSetupWizardPaths() {
    if (onboardingView) onboardingView.hidden = true;
    if (presetOnboardingView) presetOnboardingView.hidden = true;
    if (clientEntryOnboardingView) clientEntryOnboardingView.hidden = true;
  }

  function showSetupWizardChooser(returning = returningSetupVisible) {
    returningSetupVisible = returning;
    hideSetupWizardPaths();
    if (setupWizardView) setupWizardView.hidden = false;
    if (setupSourceChoice) setupSourceChoice.hidden = false;
    if (setupWizardBack) setupWizardBack.hidden = true;
    if (setupWizardContinue) setupWizardContinue.hidden = false;
    if (workspaceView) workspaceView.hidden = true;
    if (setupDraftActions) setupDraftActions.hidden = returning;
    if (setupWizardStep) setupWizardStep.textContent = "Step 1 of 3 · Choose a path";
    if (setupWizardTitle) setupWizardTitle.textContent = returning ? "Set up another MCP" : "Set up your first MCP";
    if (setupWizardCopy) {
      setupWizardCopy.textContent = returning
        ? "Choose what you already have. Choose a short lowercase name on the next step. Miftah will create a separate named configuration and will not replace an existing file."
        : "Choose what you already have. Miftah will show one setup path at a time and will not write anything until its create action.";
    }
    updateSetupSourceChoice(setupWizardSource);
    if (setupSourceChoice instanceof HTMLElement) setupSourceChoice.focus();
  }

  function selectSetupSource(source) {
    setupWizardSource = source;
    updateSetupSourceChoice(source);
    hideSetupWizardPaths();
    if (setupWizardView) setupWizardView.hidden = false;
    if (setupSourceChoice) setupSourceChoice.hidden = true;
    if (setupWizardBack) setupWizardBack.hidden = false;
    if (setupWizardContinue) setupWizardContinue.hidden = true;
    if (setupWizardStep) {
      const detail = source === "browser-sign-in"
        ? "Browser sign-in details"
        : source === "import"
          ? "Existing client entry"
          : source === "remote"
            ? "Remote endpoint details"
            : source === "local"
              ? "Local executable details"
              : "Connector details";
      setupWizardStep.textContent = "Step 2 of 3 · " + detail;
    }
    if (setupWizardCopy) setupWizardCopy.textContent = "Only the selected setup path is shown. Use Back to choose a different path or Cancel setup to leave without creating a configuration.";
    if (source === "browser-sign-in") {
      if (onboardingView) onboardingView.hidden = false;
      if (onboardingView instanceof HTMLElement) onboardingView.scrollIntoView({ block: "start" });
      const name = onboardingForm instanceof HTMLFormElement
        ? onboardingForm.querySelector("input[name='name']")
        : undefined;
      if (name instanceof HTMLInputElement) name.focus();
      message("Enter the remote MCP details below. Miftah checks supported browser sign-in before it writes a configuration.");
      return;
    }
    if (source === "import") {
      if (clientEntryOnboardingView) clientEntryOnboardingView.hidden = false;
      if (clientEntryOnboardingView instanceof HTMLElement) clientEntryOnboardingView.scrollIntoView({ block: "start" });
      const name = clientEntryOnboardingForm instanceof HTMLFormElement
        ? clientEntryOnboardingForm.querySelector("input[name='name']")
        : undefined;
      if (name instanceof HTMLInputElement) name.focus();
      message("Paste one selected client entry below. Miftah never scans or changes client settings.");
      return;
    }
    const form = byId("preset-onboarding-form");
    const selection = byId("preset-selection");
    if (!(form instanceof HTMLFormElement) || !(selection instanceof HTMLSelectElement)) return;
    if (presetOnboardingView) presetOnboardingView.hidden = false;
    const preset = source === "remote" ? "streamable-http" : source === "local" ? "local-stdio" : "generic";
    selection.value = preset;
    updatePresetFields();
    form.scrollIntoView({ block: "start" });
    const target = source === "remote"
      ? form.querySelector("input[name='url']")
      : source === "local"
        ? form.querySelector("input[name='localCommand']")
        : selection;
    if (target instanceof HTMLElement) target.focus();
    if (source === "remote") {
      message("Enter the generic HTTPS endpoint below. Miftah does not discover authentication or call it during this setup.");
    } else if (source === "local") {
      message("Enter the exact executable and arguments below. Miftah saves a no-shell argument array and will not run it during setup.");
    } else {
      message("Choose a built-in MCP or enter the exact custom package details below.");
    }
  }

  function clearSetupWizardForms() {
    [byId("preset-onboarding-form"), byId("client-entry-onboarding-form"), byId("onboarding-form")].forEach((form) => {
      if (form instanceof HTMLFormElement) form.reset();
    });
    const accounts = byId("gsc-account-list");
    if (accounts instanceof HTMLElement) accounts.replaceChildren();
    clearPresetReview();
    updatePresetFields();
  }

  function cancelSetupWizard() {
    const returning = returningSetupVisible;
    clearSetupWizardForms();
    setupWizardSource = "connector";
    updateSetupSourceChoice(setupWizardSource);
    hideSetupWizardPaths();
    returningSetupVisible = false;
    if (returning) {
      if (setupWizardView) setupWizardView.hidden = true;
      message("Setup cancelled. No configuration was created or changed.");
      if (setUpAnotherMcp instanceof HTMLButtonElement) setUpAnotherMcp.focus();
      return;
    }
    showSetupWizardChooser(false);
    message("Setup cleared. Choose a path when you are ready; nothing has been written.");
  }

  function showReturningSetup() {
    setupWizardSource = "connector";
    showSetupWizardChooser(true);
    if (setupWizardView instanceof HTMLElement) setupWizardView.scrollIntoView({ block: "start" });
    message("Choose one setup path. Miftah creates a separate named configuration and never replaces an existing file.");
  }

  /** Clears untrusted import text before routing only to an existing manual transport form. */
  function bindClientEntryManualRecoveryAction(id, source, clientEntryOnboardingForm) {
    const action = byId(id);
    if (!(action instanceof HTMLButtonElement)) return;
    action.addEventListener("click", () => {
      const documentInput = clientEntryOnboardingForm instanceof HTMLFormElement
        ? clientEntryOnboardingForm.querySelector("textarea[name='document']")
        : undefined;
      if (documentInput instanceof HTMLTextAreaElement) documentInput.value = "";
      selectSetupSource(source);
    });
  }

  async function refresh() {
    const refreshAuthenticationEpoch = authenticationEpoch;
    clearSetupCompletion();
    if (unlockView) unlockView.hidden = true;
    if (dashboardView) dashboardView.hidden = false;
    const metadata = record(await api("/api/v1/config"));
    const catalog = renderConfigurationCatalog(metadata);
    if (metadata.initialized !== true) {
      renderProviderAuthentication(undefined);
      renderProfileReadiness(undefined, "");
      if (catalog.configurations.length > 0) {
        if (!returningSetupVisible) {
          hideSetupWizardPaths();
          if (setupWizardView) setupWizardView.hidden = true;
        }
        if (workspaceView) workspaceView.hidden = true;
        if (setupDraftActions) setupDraftActions.hidden = returningSetupVisible;
        if (returningSetupVisible) {
          message("Complete the selected setup path, use Back to choose another path, or cancel without creating a configuration.");
        } else {
          message("Choose a configuration to open it, or set up another MCP. Miftah does not inspect or change MCP client settings.");
        }
        return;
      }
      if (catalog.attentionCount > 0) {
        hideSetupWizardPaths();
        returningSetupVisible = false;
        if (setupWizardView) setupWizardView.hidden = true;
        if (workspaceView) workspaceView.hidden = true;
        message("Miftah found MCP connections, but none passed every trust and validation check. Review the safe reason summary, correct the expected files, then refresh.");
        return;
      }
      if (catalog.discoveryState === "unavailable") {
        hideSetupWizardPaths();
        returningSetupVisible = false;
        if (setupWizardView) setupWizardView.hidden = true;
        if (workspaceView) workspaceView.hidden = true;
        message("Miftah could not safely inspect its standard configuration directory. Correct its local access or start the Console with --config.");
        return;
      }
      setupWizardSource = "connector";
      showSetupWizardChooser(false);
      message("No safe Miftah configuration exists yet. Choose your MCP below to create the first one.");
      return;
    }
    hideSetupWizardPaths();
    if (setupWizardView) setupWizardView.hidden = true;
    if (workspaceView) workspaceView.hidden = false;
    if (typeof window !== "undefined") {
      selectWorkspaceTask(workspaceTaskIdFromHash(window.location.hash), false);
    }
    if (setupDraftActions) setupDraftActions.hidden = false;
    renderProviderAuthentication(metadata.authentication);
    const configName = byId("config-name");
    const configVersion = byId("config-version");
    const configuredDefaultProfile = typeof metadata.defaultProfile === "string" ? metadata.defaultProfile : "";
    const defaultProfile = byId("default-profile");
    const profileSwitchingState = byId("profile-switching-state");
    const profileSwitchingCopy = byId("profile-switching-copy");
    const activeProfileGuidance = byId("active-profile-guidance");
    profileSwitchingFromMcp = metadata.profileSwitchingFromMcp === true;
    if (configName) configName.textContent = String(metadata.name || "—");
    if (configVersion) configVersion.textContent = "Config v" + String(metadata.version || "—");
    if (defaultProfile) defaultProfile.textContent = configuredDefaultProfile || "—";
    if (profileSwitchingState) profileSwitchingState.textContent = profileSwitchingFromMcp ? "Available" : "Off";
    if (profileSwitchingCopy) {
      profileSwitchingCopy.textContent = profileSwitchingFromMcp
        ? "Return to Your MCP connections and copy the request for the named account you want in this chat."
        : "Change the default account, then start a new MCP session.";
    }
    if (activeProfileGuidance) {
      activeProfileGuidance.textContent = profileSwitchingFromMcp
        ? "Active vs durable: changing the default affects new MCP sessions. For this chat, return to Your MCP connections and use the account action you need. Console does not switch a running client."
        : "Active vs durable: changing the default affects new MCP sessions. Existing sessions keep their account until you reconnect.";
    }
    const profileMetadata = Array.isArray(metadata.profiles) ? metadata.profiles.map(record) : [];
    const profiles = profileMetadata.map((item) => String(item.name || "")).filter(Boolean);
    const upstreams = Array.isArray(metadata.upstreams) ? metadata.upstreams.map((item) => String(record(item).name || "")).filter(Boolean) : [];
    renderProfileInventory(profileMetadata, configuredDefaultProfile);
    renderDefaultProfileEditor(profiles, configuredDefaultProfile);
    renderProfileDescriptionEditor(profileMetadata);
    renderProfileRenameEditor(profiles, configuredDefaultProfile);
    renderProfileRemovalEditor(profiles, configuredDefaultProfile);
    setOptions(byId("native-oauth-account-upstream"), upstreams);
    setOptions(byId("connection-profile"), profiles);
    setOptions(byId("connection-upstream"), upstreams);
    setOptions(byId("manual-connection-profile"), profiles);
    setOptions(byId("manual-connection-upstream"), upstreams);
    renderProfileReadiness(metadata.authentication, configuredDefaultProfile);
    const recoveryGeneration = sessionRecoveryGeneration;
    const settledResults = await Promise.allSettled([
      api("/api/v1/health"),
      api("/api/v1/connections"),
      api("/api/v1/audit?limit=50")
    ]);
    if (authenticationEpoch !== refreshAuthenticationEpoch || sessionRecoveryGeneration !== recoveryGeneration) {
      throw staleAuthenticationRequestError();
    }
    const failedResult = settledResults.find((result) => result.status === "rejected");
    if (failedResult && failedResult.status === "rejected") throw failedResult.reason;
    const results = settledResults.map((result) => result.status === "fulfilled" ? result.value : undefined);
    const health = record(results[0]);
    const audit = record(health.audit);
    const auditState = byId("audit-state");
    if (auditState) auditState.textContent = String(audit.state || "unknown");
    renderConnections(results[1], metadata.authentication);
    renderAudit(results[2]);
    message(profileSwitchingFromMcp
      ? "Console data refreshed. Default-account changes apply to new MCP sessions; use an account action above for this chat."
      : "Console data refreshed. Open a new MCP connection before expecting durable changes to be active.");
  }

  if (unlockForm instanceof HTMLFormElement && bootstrapInput instanceof HTMLInputElement) {
    unlockForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const bootstrapAuthenticationEpoch = authenticationEpoch;
      let bootstrapMessageEpoch = bootstrapAuthenticationEpoch;
      message("Opening the local Console…");
      try {
        const response = await fetch("/api/v1/sessions", {
          method: "POST",
          headers: { "Authorization": "Bootstrap " + bootstrapInput.value, "Content-Type": "application/json" },
          body: "{}"
        });
        bootstrapInput.value = "";
        const payload = await response.json();
        if (authenticationEpoch !== bootstrapAuthenticationEpoch) return;
        if (!response.ok) throw bootstrapResponseError(response, payload);
        if (!payload || !payload.data || typeof payload.data.csrfToken !== "string") {
          throw new Error("Miftah did not return a valid session proof.");
        }
        authenticationEpoch += 1;
        bootstrapMessageEpoch = authenticationEpoch;
        csrfToken = payload.data.csrfToken;
        await refreshAfterAuthentication();
      } catch (error) {
        if (authenticationEpoch === bootstrapMessageEpoch) {
          message(errorMessage(error));
          if (!(unlockView instanceof HTMLElement) || !unlockView.hidden) bootstrapInput.focus();
        }
      }
    });
  }

  if (configurationCatalog) {
    configurationCatalog.addEventListener("click", async (event) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-configuration]") : null;
      if (!(button instanceof HTMLButtonElement)) return;
      const configurationId = button.dataset.configuration || "";
      if (!configurationId) return;
      const actionAuthenticationEpoch = authenticationEpoch;
      button.disabled = true;
      message("Opening the selected Miftah configuration…");
      try {
        returningSetupVisible = false;
        await api("/api/v1/configurations/" + encodeURIComponent(configurationId) + "/select", {
          method: "POST",
          body: {}
        });
        await refresh();
      } catch (error) { message(errorMessage(error)); }
      finally {
        if (authenticationEpoch === actionAuthenticationEpoch) button.disabled = false;
      }
    });
  }

  if (setUpAnotherMcp instanceof HTMLButtonElement) {
    setUpAnotherMcp.addEventListener("click", showReturningSetup);
  }

  if (setupWizardContinue instanceof HTMLButtonElement) {
    setupWizardContinue.addEventListener("click", () => selectSetupSource(setupWizardSource));
  }

  if (setupWizardBack instanceof HTMLButtonElement) {
    setupWizardBack.addEventListener("click", () => {
      showSetupWizardChooser(returningSetupVisible);
      message("Choose a different setup path. Nothing has been written.");
    });
  }

  if (setupWizardCancel instanceof HTMLButtonElement) {
    setupWizardCancel.addEventListener("click", cancelSetupWizard);
  }

  const onboardingForm = byId("onboarding-form");
  if (onboardingForm instanceof HTMLFormElement) {
    onboardingForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(onboardingForm);
      message("Checking the endpoint's OAuth setup before creating the profile…");
      try {
        const result = record(await api("/api/v1/onboarding/native-oauth/discover", {
          method: "POST",
          body: {
            name: String(data.get("name") || "").trim(),
            profile: String(data.get("profile") || "").trim(),
            description: String(data.get("description") || "").trim() || undefined,
            resource: String(data.get("resource") || "").trim()
          }
        }));
        const completion = completionFromSetupResult(result, {
          name: String(data.get("name") || "").trim(),
          defaultProfile: String(data.get("profile") || "").trim()
        });
        onboardingForm.reset();
        returningSetupVisible = false;
        await refreshAfterSetup(completion);
      } catch (error) { message(errorMessage(error)); }
    });
  }

  if (setupSourceChoice instanceof HTMLElement) {
    setupSourceChoice.addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "radio") return;
      const source = input.dataset.setupSource;
      if (source === "connector" || source === "remote" || source === "local" || source === "browser-sign-in" || source === "import") {
        setupWizardSource = source;
        updateSetupSourceChoice(source);
        message("Continue to show only the selected setup path.");
      }
    });
  }

  const presetOnboardingForm = byId("preset-onboarding-form");
  if (presetOnboardingForm instanceof HTMLFormElement) {
    const presetSelection = byId("preset-selection");
    if (presetSelection instanceof HTMLSelectElement) {
      presetSelection.addEventListener("change", () => {
        updatePresetFields();
        clearPresetReview();
      });
    }
    const addGoogleSearchConsoleAccount = byId("add-gsc-account");
    if (addGoogleSearchConsoleAccount instanceof HTMLButtonElement) {
      addGoogleSearchConsoleAccount.addEventListener("click", () => {
        const list = byId("gsc-account-list");
        if (!(list instanceof HTMLElement)) return;
        clearPresetReview();
        list.append(createGoogleSearchConsoleAccountRow(googleSearchConsoleAccountRows().length));
        syncGoogleSearchConsoleDefaultProfile();
      });
    }
    updatePresetFields();
    presetOnboardingForm.addEventListener("input", clearPresetReview);
    presetOnboardingForm.addEventListener("change", clearPresetReview);
    presetOnboardingForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (presetCreateInFlight) {
        message("Wait for the reviewed configuration to finish creating.");
        return;
      }
      clearPresetReview();
      const reviewGeneration = presetReviewGeneration;
      message("Validating the setup for review…");
      try {
        const request = presetOnboardingRequest(presetOnboardingForm);
        const review = record(await api("/api/v1/onboarding/preset/preview", { method: "POST", body: request }));
        if (reviewGeneration !== presetReviewGeneration) return;
        renderPresetReview(review);
        pendingPresetRequest = request;
        message("Review the structural summary, then create the configuration when it matches your intent.");
      } catch (error) {
        if (reviewGeneration === presetReviewGeneration) message(errorMessage(error));
      }
    });
  }

  if (saveSetupDraft instanceof HTMLButtonElement) {
    saveSetupDraft.addEventListener("click", async () => {
      if (saveSetupDraft.disabled) return;
      const actionAuthenticationEpoch = authenticationEpoch;
      saveSetupDraft.disabled = true;
      message("Saving only the MCP choice…");
      try {
        const draft = await api("/api/v1/setup-draft", { method: "PUT", body: setupDraftIntent() });
        restoreSetupDraft(draft);
        message("Saved the configuration name and MCP choice. Re-enter every connection detail when you continue.");
      } catch (error) { message(errorMessage(error)); }
      finally {
        if (authenticationEpoch === actionAuthenticationEpoch) saveSetupDraft.disabled = false;
      }
    });
  }

  if (resumeSetupDraft instanceof HTMLButtonElement) {
    resumeSetupDraft.addEventListener("click", async () => {
      if (resumeSetupDraft.disabled) return;
      const actionAuthenticationEpoch = authenticationEpoch;
      resumeSetupDraft.disabled = true;
      message("Loading the saved MCP choice…");
      try {
        const draft = await api("/api/v1/setup-draft");
        if (draft === undefined || draft === null) {
          activeSetupDraft = undefined;
          renderSetupDraftControls();
          message("No saved MCP choice exists. Start with a configuration name and MCP above.");
          return;
        }
        restoreSetupDraft(draft);
        message("Restored only the configuration name and MCP choice. Re-enter every connection value before reviewing.");
      } catch (error) { message(errorMessage(error)); }
      finally {
        if (authenticationEpoch === actionAuthenticationEpoch) resumeSetupDraft.disabled = false;
      }
    });
  }

  if (discardSetupDraft instanceof HTMLButtonElement) {
    discardSetupDraft.addEventListener("click", async () => {
      if (activeSetupDraft === undefined || discardSetupDraft.disabled) return;
      const actionAuthenticationEpoch = authenticationEpoch;
      discardSetupDraft.disabled = true;
      message("Discarding the saved MCP choice…");
      try {
        await api("/api/v1/setup-draft", { method: "DELETE", body: { revision: activeSetupDraft.revision } });
        activeSetupDraft = undefined;
        renderSetupDraftControls();
        message("Discarded the saved MCP choice. The current form stays open and is not saved.");
      } catch (error) { message(errorMessage(error)); }
      finally {
        if (authenticationEpoch === actionAuthenticationEpoch) discardSetupDraft.disabled = false;
      }
    });
  }

  renderSetupDraftControls();

  if (presetCreateReviewed instanceof HTMLButtonElement) {
    presetCreateReviewed.addEventListener("click", async () => {
      const request = pendingPresetRequest;
      if (request === undefined) {
        message("Review a configuration before creating it.");
        return;
      }
      if (presetCreateInFlight || presetCreateReviewed.disabled) return;
      const actionAuthenticationEpoch = authenticationEpoch;
      message("Creating the reviewed Miftah configuration…");
      presetCreateInFlight = true;
      setPresetReviewActionsDisabled(true);
      try {
        const result = record(await api("/api/v1/onboarding/preset", { method: "POST", body: request }));
        const completion = completionFromSetupResult(result);
        clearPresetReview();
        activeSetupDraft = undefined;
        renderSetupDraftControls();
        if (presetOnboardingForm instanceof HTMLFormElement) {
          presetOnboardingForm.reset();
          updatePresetFields();
        }
        returningSetupVisible = false;
        await refreshAfterSetup(completion);
      } catch (error) { message(errorMessage(error)); }
      finally {
        if (authenticationEpoch === actionAuthenticationEpoch) {
          presetCreateInFlight = false;
          if (pendingPresetRequest !== undefined) setPresetReviewActionsDisabled(false);
        }
      }
    });
  }

  if (presetReviewEdit instanceof HTMLButtonElement) {
    presetReviewEdit.addEventListener("click", () => {
      clearPresetReview();
      const name = presetOnboardingForm instanceof HTMLFormElement
        ? presetOnboardingForm.querySelector("input[name='name']")
        : undefined;
      if (name instanceof HTMLInputElement) name.focus();
      message("Update the setup details, then review the configuration again.");
    });
  }

  const clientEntryOnboardingForm = byId("client-entry-onboarding-form");
  bindClientEntryManualRecoveryAction("client-entry-manual-local", "local", clientEntryOnboardingForm);
  bindClientEntryManualRecoveryAction("client-entry-manual-remote", "remote", clientEntryOnboardingForm);
  if (clientEntryOnboardingForm instanceof HTMLFormElement) {
    clientEntryOnboardingForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const actionAuthenticationEpoch = authenticationEpoch;
      const documentInput = clientEntryOnboardingForm.querySelector("textarea[name='document']");
      message("Importing one selected MCP entry…");
      try {
        const data = new FormData(clientEntryOnboardingForm);
        const result = record(await api("/api/v1/onboarding/client-entry", {
          method: "POST",
          body: {
            name: String(data.get("name") || "").trim(),
            entry: String(data.get("entry") || "").trim(),
            document: String(data.get("document") || "")
          }
        }));
        const completion = completionFromSetupResult(result);
        clientEntryOnboardingForm.reset();
        returningSetupVisible = false;
        await refreshAfterSetup(completion);
      } catch (error) { message(errorMessage(error)); }
      finally {
        if (authenticationEpoch === actionAuthenticationEpoch && documentInput instanceof HTMLTextAreaElement) {
          documentInput.value = "";
        }
      }
    });
  }

  const connectionForm = byId("connection-form");
  if (connectionForm instanceof HTMLFormElement) {
    connectionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(connectionForm);
      message("Checking the configured endpoint's OAuth setup before adding the connection…");
      try {
        await api("/api/v1/connections/discover", {
          method: "POST",
          body: {
            profile: String(data.get("profile") || ""),
            upstream: String(data.get("upstream") || "")
          }
        });
        connectionForm.reset();
        await refresh();
      } catch (error) { message(errorMessage(error)); }
    });
  }

  const nativeOAuthAccountForm = byId("native-oauth-account-form");
  if (nativeOAuthAccountForm instanceof HTMLFormElement) {
    nativeOAuthAccountForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(nativeOAuthAccountForm);
      message("Checking the configured endpoint's OAuth setup before adding the account…");
      try {
        await api("/api/v1/profiles/native-oauth/discover", {
          method: "POST",
          body: {
            profile: String(data.get("profile") || "").trim(),
            description: String(data.get("description") || "").trim() || undefined,
            upstream: String(data.get("upstream") || ""),
            ...(data.get("makeDefault") === "true" ? { makeDefault: true } : {})
          }
        });
        nativeOAuthAccountForm.reset();
        await refresh();
      } catch (error) { message(errorMessage(error)); }
    });
  }

  const providerAccountForm = byId("provider-account-form");
  if (providerAccountForm instanceof HTMLFormElement) {
    providerAccountForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(providerAccountForm);
      message("Adding the provider-owned account without reading its OAuth cache…");
      try {
        await api("/api/v1/profiles/provider-account", {
          method: "POST",
          body: {
            profile: String(data.get("profile") || "").trim(),
            description: String(data.get("description") || "").trim() || undefined,
            credentialFile: String(data.get("credentialFile") || "").trim(),
            ...(data.get("makeDefault") === "true" ? { makeDefault: true } : {})
          }
        });
        providerAccountForm.reset();
        await refresh();
      } catch (error) { message(errorMessage(error)); }
    });
  }

  const environmentProfileForm = byId("environment-profile-form");
  if (environmentProfileForm instanceof HTMLFormElement) {
    environmentProfileForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(environmentProfileForm);
      message("Adding the environment-backed account without reading its credential or launching the upstream…");
      try {
        await api("/api/v1/profiles/environment-account", {
          method: "POST",
          body: {
            profile: String(data.get("profile") || "").trim(),
            description: String(data.get("description") || "").trim() || undefined,
            credentialEnv: String(data.get("credentialEnv") || "").trim(),
            ...(data.get("makeDefault") === "true" ? { makeDefault: true } : {})
          }
        });
        environmentProfileForm.reset();
        await refresh();
      } catch (error) { message(errorMessage(error)); }
    });
  }

  const manualConnectionForm = byId("manual-connection-form");
  if (manualConnectionForm instanceof HTMLFormElement) {
    manualConnectionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(manualConnectionForm);
      message("Adding the reviewed manual OAuth binding…");
      try {
        await api("/api/v1/connections", {
          method: "POST",
          body: {
            profile: String(data.get("profile") || ""),
            upstream: String(data.get("upstream") || ""),
            issuer: String(data.get("issuer") || "").trim(),
            clientRegistration: registration(manualConnectionForm),
            scopes: scopes(manualConnectionForm)
          }
        });
        manualConnectionForm.reset();
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
      const actionAuthenticationEpoch = authenticationEpoch;
      button.disabled = true;
      message(action === "credential" ? "Removing the exact local vault credential…" : "Running " + action + "…");
      try {
        await api("/api/v1/connections/" + encodeURIComponent(reference) + "/" + action, {
          method: action === "credential" ? "DELETE" : "POST",
          body: {}
        });
        await refresh();
      } catch (error) { message(errorMessage(error)); }
      finally {
        if (authenticationEpoch === actionAuthenticationEpoch) button.disabled = false;
      }
    });
  }

  const runProfileReadiness = byId("run-profile-readiness");
  const profileReadinessProfile = byId("profile-readiness-profile");
  if (profileReadinessProfile instanceof HTMLSelectElement) {
    profileReadinessProfile.addEventListener("change", () => syncProfileReadinessUpstreams());
  }
  const profileReadinessUpstream = byId("profile-readiness-upstream");
  if (profileReadinessUpstream instanceof HTMLSelectElement) {
    profileReadinessUpstream.addEventListener("change", clearProfileReadinessResult);
  }
  if (runProfileReadiness instanceof HTMLButtonElement) {
    runProfileReadiness.addEventListener("click", async () => {
      const profile = byId("profile-readiness-profile");
      const upstream = byId("profile-readiness-upstream");
      const result = byId("profile-readiness-result");
      if (!(profile instanceof HTMLSelectElement) || !profile.value || !(upstream instanceof HTMLSelectElement) || !upstream.value) return;
      if (!profileReadinessTargets.some((target) => target.profile === profile.value && target.upstream === upstream.value)) {
        message("This profile does not have a reviewed safe check.");
        return;
      }
      clearProfileReadinessResult();
      const readinessGeneration = profileReadinessGeneration;
      const actionAuthenticationEpoch = authenticationEpoch;
      const selectedProfile = profile.value;
      const selectedUpstream = upstream.value;
      runProfileReadiness.disabled = true;
      message("Running the reviewed safe check…");
      try {
        const report = await api("/api/v1/profile-readiness", {
          method: "POST",
          body: { profile: profile.value, upstream: upstream.value }
        });
        const publicResult = profileReadinessMessage(report);
        if (
          readinessGeneration !== profileReadinessGeneration ||
          profile.value !== selectedProfile ||
          upstream.value !== selectedUpstream
        ) return;
        if (result) result.textContent = publicResult;
        message(publicResult);
        renderAudit(await api("/api/v1/audit?limit=50"));
      } catch (error) {
        if (readinessGeneration === profileReadinessGeneration) message(errorMessage(error));
      }
      finally {
        if (authenticationEpoch === actionAuthenticationEpoch) runProfileReadiness.disabled = false;
      }
    });
  }

  const setDefaultProfile = byId("set-default-profile");
  if (setDefaultProfile instanceof HTMLButtonElement) {
    setDefaultProfile.addEventListener("click", async () => {
      const profile = byId("default-profile-selection");
      const result = byId("default-profile-result");
      if (!(profile instanceof HTMLSelectElement) || !profile.value) return;
      const actionAuthenticationEpoch = authenticationEpoch;
      const selectedProfile = profile.value;
      setDefaultProfile.disabled = true;
      message("Saving the durable default profile…");
      try {
        const report = record(await api("/api/v1/profiles/default", {
          method: "POST",
          body: { profile: profile.value }
        }));
        const publicResult = report.changed === true
          ? "Durable default profile set to " + selectedProfile + "."
          : "This profile is already the durable default.";
        if (result) result.textContent = publicResult;
        await refresh();
        message(publicResult + (profileSwitchingFromMcp
          ? " New MCP sessions will use it; use an account action above for this chat."
          : " Open a new MCP connection to use it.") +
          " If you are using the configuration catalog, select this configuration again before another Console change.");
      } catch (error) { message(errorMessage(error)); }
      finally {
        if (authenticationEpoch === actionAuthenticationEpoch) setDefaultProfile.disabled = false;
      }
    });
  }

  const setProfileDescription = byId("set-profile-description");
  const clearProfileDescription = byId("clear-profile-description");
  async function saveProfileDescription(clearDescription) {
    const profile = byId("profile-description-selection");
    const input = byId("profile-description-input");
    const result = byId("profile-description-result");
    if (!(profile instanceof HTMLSelectElement) || !profile.value || !(input instanceof HTMLInputElement)) return;
    const actionAuthenticationEpoch = authenticationEpoch;
    const selectedProfile = profile.value;
    const description = input.value.trim();
    if (!clearDescription && !description) {
      message("Enter a non-secret account label or use Clear label.");
      input.focus();
      return;
    }
    if (setProfileDescription instanceof HTMLButtonElement) setProfileDescription.disabled = true;
    if (clearProfileDescription instanceof HTMLButtonElement) clearProfileDescription.disabled = true;
    message(clearDescription ? "Clearing the account label…" : "Saving the account label…");
    try {
      const report = record(await api("/api/v1/profiles/description", {
        method: "POST",
        body: clearDescription
          ? { profile: selectedProfile, clearDescription: true }
          : { profile: selectedProfile, description }
      }));
      const publicResult = report.changed === true
        ? clearDescription ? "Account label cleared for " + selectedProfile + "." : "Account label saved for " + selectedProfile + "."
        : clearDescription ? "This account label is already clear." : "This account label is already current.";
      if (result) result.textContent = publicResult;
      await refresh();
      message(publicResult + " Existing MCP clients need a restart; if you are using the configuration catalog, select this configuration again before another Console change.");
    } catch (error) { message(errorMessage(error)); }
    finally {
      if (authenticationEpoch === actionAuthenticationEpoch) {
        if (setProfileDescription instanceof HTMLButtonElement) setProfileDescription.disabled = false;
        if (clearProfileDescription instanceof HTMLButtonElement) clearProfileDescription.disabled = false;
      }
    }
  }

  if (setProfileDescription instanceof HTMLButtonElement) {
    setProfileDescription.addEventListener("click", () => void saveProfileDescription(false));
  }
  if (clearProfileDescription instanceof HTMLButtonElement) {
    clearProfileDescription.addEventListener("click", () => void saveProfileDescription(true));
  }

  const renameProfile = byId("rename-profile");
  if (renameProfile instanceof HTMLButtonElement) {
    renameProfile.addEventListener("click", async () => {
      const profile = byId("profile-rename-selection");
      const input = byId("profile-rename-input");
      const result = byId("profile-rename-result");
      if (!(profile instanceof HTMLSelectElement) || !profile.value || !(input instanceof HTMLInputElement)) return;
      const selectedProfile = profile.value;
      const newProfile = input.value.trim();
      if (!newProfile) {
        message("Enter a distinct safe account profile name.");
        input.focus();
        return;
      }
      if (newProfile === selectedProfile) {
        message("Choose a new account profile name that differs from the current one.");
        input.focus();
        return;
      }
      const actionAuthenticationEpoch = authenticationEpoch;
      renameProfile.disabled = true;
      message("Renaming the selected account in Miftah configuration…");
      try {
        const report = record(await api("/api/v1/profiles/rename", {
          method: "POST",
          body: { profile: selectedProfile, newProfile }
        }));
        const publicResult = report.changed === true
          ? "Renamed account " + selectedProfile + " to " + newProfile + "."
          : "This account was not changed.";
        if (result) result.textContent = publicResult;
        await refresh();
        message(publicResult + " Existing MCP clients need a restart; if you are using the configuration catalog, select this configuration again before another Console change.");
      } catch (error) { message(errorMessage(error)); }
      finally {
        const editor = byId("profile-rename-editor");
        if (authenticationEpoch === actionAuthenticationEpoch && editor instanceof HTMLElement && !editor.hidden) {
          renameProfile.disabled = false;
        }
      }
    });
  }

  const removeProfile = byId("remove-profile");
  if (removeProfile instanceof HTMLButtonElement) {
    removeProfile.addEventListener("click", async () => {
      const profile = byId("profile-removal-selection");
      const replacement = byId("profile-removal-replacement");
      const confirmation = byId("confirm-profile-removal");
      const result = byId("profile-removal-result");
      if (!(profile instanceof HTMLSelectElement) || !profile.value || !(replacement instanceof HTMLSelectElement) || !replacement.value) return;
      if (!(confirmation instanceof HTMLInputElement) || !confirmation.checked) {
        message("Confirm that you want to remove this account from the Miftah configuration.");
        return;
      }
      const selectedProfile = profile.value;
      const replacementProfile = replacement.value;
      const actionAuthenticationEpoch = authenticationEpoch;
      removeProfile.disabled = true;
      message("Removing the selected account from Miftah configuration…");
      try {
        const report = record(await api("/api/v1/profiles/remove", {
          method: "POST",
          body: { profile: selectedProfile, replacementProfile }
        }));
        const publicResult = report.changed === true
          ? "Removed account " + selectedProfile + "."
          : "This account was not changed.";
        if (result) result.textContent = publicResult;
        await refresh();
        message(publicResult + " Existing MCP clients need a restart; if you are using the configuration catalog, select this configuration again before another Console change.");
      } catch (error) { message(errorMessage(error)); }
      finally {
        const editor = byId("profile-removal-editor");
        if (authenticationEpoch === actionAuthenticationEpoch && editor instanceof HTMLElement && !editor.hidden) {
          removeProfile.disabled = false;
        }
      }
    });
  }

  if (setupCompletionClientSelect instanceof HTMLSelectElement) {
    setupCompletionClientSelect.addEventListener("change", () => {
      setupCompletionGeneration += 1;
      renderSetupCompletionSwitch(record(record(setupCompletion).setup));
      if (setupCompletionClientTarget) setupCompletionClientTarget.textContent = "";
      if (setupCompletionClientJson instanceof HTMLTextAreaElement) setupCompletionClientJson.value = "";
      if (setupCompletionClientGuidance) setupCompletionClientGuidance.textContent = "";
      if (setupCompletionHandoff) setupCompletionHandoff.textContent = "";
      if (setupCompletionCopyJson instanceof HTMLButtonElement) setupCompletionCopyJson.disabled = true;
      if (setupCompletionGenerateEntry instanceof HTMLButtonElement) setupCompletionGenerateEntry.disabled = false;
    });
  }

  if (setupCompletionGenerateEntry instanceof HTMLButtonElement) {
    setupCompletionGenerateEntry.addEventListener("click", async () => {
      if (setupCompletionGenerateEntry.disabled) return;
      setupCompletionGenerateEntry.disabled = true;
      const client = selectedSetupCompletionClient();
      const generation = setupCompletionGeneration;
      try {
        const snippets = await api("/api/v1/client-snippets?client=" + encodeURIComponent(client));
        if (!setupCompletionRequestIsCurrent(generation, client)) return;
        const snippet = Array.isArray(snippets) ? record(snippets[0]) : {};
        const target = record(snippet.target);
        const json = typeof snippet.json === "string" ? snippet.json : "";
        const guidance = typeof snippet.guidance === "string" ? snippet.guidance : "";
        if (!json || typeof target.label !== "string") throw new Error("A client entry was not available for the selected client.");
        if (setupCompletionClientTarget) {
          setupCompletionClientTarget.textContent = "Merge this one entry into " + target.label + ". Miftah did not edit that file.";
        }
        if (setupCompletionClientJson instanceof HTMLTextAreaElement) setupCompletionClientJson.value = json;
        if (setupCompletionClientGuidance) setupCompletionClientGuidance.textContent = guidance;
        if (setupCompletionCopyJson instanceof HTMLButtonElement) setupCompletionCopyJson.disabled = false;
        if (setupCompletionHandoff) {
          setupCompletionHandoff.textContent =
            "Review and merge the entry, then restart or reconnect " + catalogClientDisplayName(client) +
            ". A generated entry does not prove that a credential works or belongs to the intended account.";
        }
        message("Generated the copy-only client entry for " + catalogClientDisplayName(client) + ". Review it before merging.");
      } catch (error) {
        if (setupCompletionRequestIsCurrent(generation, client)) message(errorMessage(error));
      } finally {
        if (setupCompletionRequestIsCurrent(generation, client)) setupCompletionGenerateEntry.disabled = false;
      }
    });
  }

  if (setupCompletionCopyJson instanceof HTMLButtonElement) {
    setupCompletionCopyJson.addEventListener("click", async () => {
      if (!(setupCompletionClientJson instanceof HTMLTextAreaElement) || !setupCompletionClientJson.value) return;
      try {
        await navigator.clipboard.writeText(setupCompletionClientJson.value);
        message("Client JSON copied. Miftah did not modify any client file.");
      } catch {
        setupCompletionClientJson.focus();
        setupCompletionClientJson.select();
        message("Clipboard access was unavailable. The client JSON is selected for manual copy.");
      }
    });
  }

  const generateSnippet = byId("generate-snippet");
  if (generateSnippet instanceof HTMLButtonElement) {
    generateSnippet.addEventListener("click", async () => {
      const select = byId("client-select");
      const output = byId("snippet-output");
      const guidance = byId("snippet-guidance");
      if (
        !(select instanceof HTMLSelectElement) ||
        !(output instanceof HTMLTextAreaElement) ||
        !(guidance instanceof HTMLElement)
      ) return;
      try {
        const snippets = await api("/api/v1/client-snippets?client=" + encodeURIComponent(select.value));
        const first = Array.isArray(snippets) ? record(snippets[0]) : {};
        output.value = typeof first.json === "string" ? first.json : "";
        guidance.textContent = typeof first.guidance === "string" ? first.guidance : "";
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
  if (typeof window !== "undefined") {
    initializeWorkspaceTaskNavigation();
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) void resumeSession();
    });
    void resumeSession();
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
