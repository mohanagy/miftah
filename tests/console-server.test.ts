import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startConsoleServer,
  type ConsoleControlApplication
} from "../src/console/console-server.js";
import { ConsoleDashboardApplicationService } from "../src/console/console-dashboard-application-service.js";
import { ConsoleApplicationService } from "../src/console/console-application-service.js";
import { buildPresetConfig } from "../src/config/presets.js";
import { MiftahError } from "../src/utils/errors.js";
import {
  createPrivateConsoleDirectory,
  writePrivateConsoleFile
} from "./helpers/private-console-directory.js";
import { environmentProfileConfig } from "./helpers/environment-profile-config.js";
import { startOAuthCompatibilityProbe } from "./helpers/fake-remote-upstream.js";

const temporaryDirectories: string[] = [];

function supportedKnownConnectorOptions(): {
  readonly preset: string;
  readonly credentialEnv: string;
  readonly npmPackage?: string;
  readonly dockerImage?: string;
} {
  return process.platform === "win32"
    ? {
        preset: "generic-docker",
        dockerImage: "ghcr.io/acme/server@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        credentialEnv: "SUPPORT_TOKEN"
      }
    : {
        preset: "generic-npx",
        npmPackage: "@scope/server@1.2.3",
        credentialEnv: "SUPPORT_TOKEN"
      };
}

function importableClientEntry(): { readonly command: string; readonly args: readonly string[] } {
  return process.platform === "win32"
    ? { command: process.execPath, args: ["server.mjs"] }
    : { command: "npx", args: ["--yes", "@posthog/mcp@1.2.3"] };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function writeConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-console-server-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "miftah.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "1",
      name: "console-test",
      defaultProfile: "personal",
      upstream: { transport: "stdio", command: process.execPath, args: ["provider.mjs"] },
      profiles: { personal: { description: "Personal account" }, work: {} }
    })
  );
  return path;
}

async function writeOAuthConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-console-oauth-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "miftah.json");
  await writeFile(
    path,
    JSON.stringify({
      version: "2",
      name: "console-oauth-test",
      defaultProfile: "personal",
      upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
      profiles: { personal: { description: "Personal account" }, work: {} }
    }, null, 2)
  );
  return path;
}

async function rawPost(
  url: URL,
  headers: Readonly<Record<string, string>>,
  body: string
): Promise<{ readonly status: number; readonly body: string; readonly headers: NodeJS.Dict<string | string[]> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers
        }));
      }
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function bootstrapSession(server: Awaited<ReturnType<typeof startConsoleServer>>): Promise<{
  readonly cookie: string;
  readonly csrfToken: string;
}> {
  const response = await fetch(new URL("/api/v1/sessions", server.url), {
    method: "POST",
    headers: {
      origin: server.url.origin,
      authorization: `Bootstrap ${server.bootstrapCredential}`,
      "content-type": "application/json"
    },
    body: "{}"
  });
  expect(response.status).toBe(201);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const body = await response.json() as { readonly data: { readonly csrfToken: string } };
  if (cookie === undefined) throw new Error("Expected a Console session cookie.");
  return { cookie, csrfToken: body.data.csrfToken };
}

async function submitPresetFormWithStaleValue(
  javascript: string,
  suppliedValues?: Readonly<Record<string, string>>
): Promise<Record<string, unknown>> {
  type SubmitListener = (event: { readonly preventDefault: () => void }) => void | Promise<void>;
  class FakeForm {
    readonly listeners = new Map<string, SubmitListener>();
    readonly values: Record<string, string> = {
      name: "analytics",
      preset: "generic-npx",
      credentialEnv: "ANALYTICS_TOKEN",
      npmPackage: "@vendor/mcp-server@1.2.3",
      ...suppliedValues
    };

    addEventListener(name: string, listener: SubmitListener): void {
      this.listeners.set(name, listener);
    }

    querySelectorAll(): readonly unknown[] {
      return [];
    }

    reset(): void {}
  }
  class FakeSelect {
    readonly listeners = new Map<string, () => void>();

    constructor(public value: string) {}

    addEventListener(name: string, listener: () => void): void {
      this.listeners.set(name, listener);
    }
  }
  class FakeFormData {
    constructor(private readonly form: FakeForm) {}

    get(name: string): string | null {
      return this.form.values[name] ?? null;
    }
  }

  const form = new FakeForm();
  const selection = new FakeSelect(form.values.preset ?? "generic-npx");
  const requests: Array<{ readonly path: string; readonly body?: string }> = [];
  runInNewContext(javascript, {
    document: {
      getElementById(id: string): unknown {
        if (id === "preset-onboarding-form") return form;
        if (id === "preset-selection") return selection;
        return undefined;
      }
    },
    HTMLFormElement: FakeForm,
    HTMLSelectElement: FakeSelect,
    HTMLElement: class {},
    HTMLInputElement: class {},
    HTMLButtonElement: class {},
    HTMLTextAreaElement: class {},
    Element: class {},
    FormData: FakeFormData,
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async (path: unknown, options?: { readonly body?: unknown }) => {
      const requestPath = String(path);
      requests.push({
        path: requestPath,
        ...(typeof options?.body === "string" ? { body: options.body } : {})
      });
      return {
        ok: true,
        status: 200,
        json: async () => requestPath === "/api/v1/config"
          ? { data: { initialized: false } }
          : { data: {} }
      };
    }
  });

  if (suppliedValues === undefined) {
    // Model a user entering a package for generic-npx, then changing to generic.
    selection.value = "generic";
    form.values.preset = "generic";
    selection.listeners.get("change")?.();
  }
  const submit = form.listeners.get("submit");
  if (submit === undefined) throw new Error("Expected the preset setup submit handler.");
  await submit({ preventDefault: () => undefined });

  const request = requests.find((entry) => entry.path === "/api/v1/onboarding/preset");
  if (request?.body === undefined) throw new Error("Expected a preset onboarding request.");
  return JSON.parse(request.body) as Record<string, unknown>;
}

function selectConsoleRemoteSetupSource(javascript: string): {
  readonly preset: string;
  readonly updateCalls: number;
  readonly focused: boolean;
  readonly status: string;
} {
  const start = javascript.indexOf("function selectSetupSource(source)");
  const end = javascript.indexOf("\n\n  async function refresh", start);
  if (start < 0 || end < 0) throw new Error("Expected the Console setup-source selector.");

  class FakeElement {
    focused = false;

    focus(): void {
      this.focused = true;
    }

    scrollIntoView(): void {}
  }
  class FakeForm extends FakeElement {
    querySelector(selector: string): unknown {
      return selector === "input[name='url']" ? remoteUrl : undefined;
    }
  }
  class FakeSelect extends FakeElement {
    value = "generic";
  }
  class FakeInput extends FakeElement {}

  const form = new FakeForm();
  const selection = new FakeSelect();
  const remoteUrl = new FakeInput();
  let updateCalls = 0;
  let status = "";
  const selectSetupSource = runInNewContext(`${javascript.slice(start, end)}\nselectSetupSource`, {
    byId(id: string): unknown {
      if (id === "preset-onboarding-form") return form;
      if (id === "preset-selection") return selection;
      return undefined;
    },
    updateSetupSourceChoice(): void {},
    updatePresetFields(): void {
      updateCalls += 1;
    },
    message(value: string): void {
      status = value;
    },
    HTMLFormElement: FakeForm,
    HTMLSelectElement: FakeSelect,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLButtonElement: FakeElement
  }) as (source: string) => void;

  selectSetupSource("remote");
  return { preset: selection.value, updateCalls, focused: remoteUrl.focused, status };
}

function triggerClientEntryManualRecoveryAction(
  javascript: string,
  id: string,
  source: string
): { readonly selected: readonly string[]; readonly documentCleared: boolean } {
  const start = javascript.indexOf("function bindClientEntryManualRecoveryAction(id, source)");
  const end = javascript.indexOf("\n\n  async function refresh", start);
  if (start < 0 || end < 0) throw new Error("Expected the client-entry manual recovery action binder.");

  class FakeButton {
    readonly listeners = new Map<string, () => void>();

    addEventListener(name: string, listener: () => void): void {
      this.listeners.set(name, listener);
    }
  }
  class FakeTextArea {
    value = "pasted-source-that-must-not-remain";
  }
  class FakeForm {
    querySelector(selector: string): unknown {
      return selector === "textarea[name='document']" ? documentInput : undefined;
    }
  }

  const button = new FakeButton();
  const documentInput = new FakeTextArea();
  const form = new FakeForm();
  const selected: string[] = [];
  const bindClientEntryManualRecoveryAction = runInNewContext(
    `${javascript.slice(start, end)}\nbindClientEntryManualRecoveryAction`,
    {
      byId(candidate: string): unknown {
        if (candidate === id) return button;
        if (candidate === "client-entry-onboarding-form") return form;
        return undefined;
      },
      HTMLButtonElement: FakeButton,
      HTMLFormElement: FakeForm,
      HTMLTextAreaElement: FakeTextArea,
      selectSetupSource(value: string): void {
        selected.push(value);
      }
    }
  ) as (targetId: string, targetSource: string) => void;

  bindClientEntryManualRecoveryAction(id, source);
  button.listeners.get("click")?.();
  return { selected, documentCleared: documentInput.value === "" };
}

function clearProfileReadinessResultOnTargetChange(javascript: string): {
  readonly afterProfileChange: string;
  readonly afterUpstreamChange: string;
} {
  type ChangeListener = () => void;

  class FakeElement {
    textContent = "";
  }
  class FakeSelect extends FakeElement {
    readonly listeners = new Map<string, ChangeListener>();
    value = "profile-a";

    addEventListener(name: string, listener: ChangeListener): void {
      this.listeners.set(name, listener);
    }

    append(): void {}

    replaceChildren(): void {}
  }

  const profile = new FakeSelect();
  const upstream = new FakeSelect();
  const result = new FakeElement();
  runInNewContext(javascript, {
    document: {
      getElementById(id: string): unknown {
        if (id === "profile-readiness-profile") return profile;
        if (id === "profile-readiness-upstream") return upstream;
        if (id === "profile-readiness-result") return result;
        return undefined;
      },
      createElement(): FakeElement {
        return new FakeElement();
      }
    },
    HTMLFormElement: class {},
    HTMLSelectElement: FakeSelect,
    HTMLElement: FakeElement,
    HTMLInputElement: class {},
    HTMLButtonElement: class {},
    HTMLTextAreaElement: class {},
    Element: FakeElement,
    navigator: { clipboard: { writeText: async () => undefined } }
  });

  result.textContent = "Completed for profile-a";
  profile.listeners.get("change")?.();
  const afterProfileChange = result.textContent;

  result.textContent = "Completed for profile-b";
  upstream.listeners.get("change")?.();
  return { afterProfileChange, afterUpstreamChange: result.textContent };
}

function preserveProfileDescriptionSelectionAcrossRefresh(javascript: string): {
  readonly profile: string;
  readonly description: string;
} {
  const start = javascript.indexOf("function renderProfileDescriptionEditor");
  const end = javascript.indexOf("\n  function renderProfileInventory", start);
  if (start < 0 || end < 0) throw new Error("Expected the profile-description editor renderer.");

  class FakeElement {
    hidden = false;
    disabled = false;
    textContent = "";
  }
  class FakeInput extends FakeElement {
    value = "";
  }
  class FakeSelect extends FakeElement {
    value = "";
    onchange: (() => void) | undefined;
  }
  class FakeButton extends FakeElement {}

  const profile = new FakeSelect();
  const input = new FakeInput();
  const elements: Record<string, FakeElement> = {
    "profile-description-editor": new FakeElement(),
    "profile-description-selection": profile,
    "profile-description-input": input,
    "set-profile-description": new FakeButton(),
    "clear-profile-description": new FakeButton(),
    "profile-description-result": new FakeElement()
  };
  const render = runInNewContext(`${javascript.slice(start, end)}\nrenderProfileDescriptionEditor`, {
    byId(id: string): unknown {
      return elements[id];
    },
    record(value: unknown): Record<string, unknown> {
      return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
    },
    setOptions(select: FakeSelect, options: readonly string[]): void {
      select.value = options[0] ?? "";
    },
    HTMLSelectElement: FakeSelect,
    HTMLInputElement: FakeInput,
    HTMLButtonElement: FakeButton
  }) as (metadata: unknown) => void;
  const metadata = [
    { name: "work", description: "Work account" },
    { name: "personal", description: "Personal account" }
  ];

  render(metadata);
  profile.value = "personal";
  render(metadata);
  return { profile: profile.value, description: input.value };
}

async function clearProfileReadinessStateWhenConfigurationIsUnselected(javascript: string): Promise<{
  readonly visibleAfterSelection: boolean;
  readonly hiddenAfterUnselection: boolean;
  readonly readinessRequestsAfterUnselection: number;
}> {
  type Listener = (event?: { readonly preventDefault: () => void }) => void | Promise<void>;

  class FakeElement {
    hidden = true;
    disabled = false;
    textContent = "";
    value = "";
    className = "";
    readonly dataset: Record<string, string> = {};
    readonly listeners = new Map<string, Listener>();

    addEventListener(name: string, listener: Listener): void {
      this.listeners.set(name, listener);
    }

    append(...children: unknown[]): void {
      void children;
    }

    replaceChildren(...children: unknown[]): void {
      void children;
    }

    focus(): void {}

    select(): void {}
  }

  class FakeForm extends FakeElement {
    reset(): void {}
  }

  class FakeInput extends FakeElement {}
  class FakeSelect extends FakeElement {
    override replaceChildren(...children: unknown[]): void {
      void children;
      this.value = "";
    }

    override append(...children: unknown[]): void {
      const option = children.find((child): child is FakeElement => child instanceof FakeElement && child.value.length > 0);
      if (!this.value && option !== undefined) this.value = option.value;
    }
  }
  class FakeButton extends FakeElement {}
  class FakeTextArea extends FakeElement {}

  const unlockForm = new FakeForm();
  const bootstrapInput = new FakeInput();
  const readinessView = new FakeElement();
  const readinessProfile = new FakeSelect();
  const readinessUpstream = new FakeSelect();
  const readinessResult = new FakeElement();
  const readinessButton = new FakeButton();
  const elements: Record<string, FakeElement> = {
    status: new FakeElement(),
    "dashboard-view": new FakeElement(),
    "unlock-view": new FakeElement(),
    "unlock-form": unlockForm,
    bootstrap: bootstrapInput,
    "onboarding-view": new FakeElement(),
    "preset-onboarding-view": new FakeElement(),
    "workspace-view": new FakeElement(),
    "configuration-catalog-view": new FakeElement(),
    "configuration-catalog": new FakeElement(),
    "provider-authentication-view": new FakeElement(),
    "provider-authentication-copy": new FakeElement(),
    "native-oauth-editor": new FakeElement(),
    "profile-readiness-view": readinessView,
    "profile-readiness-profile": readinessProfile,
    "profile-readiness-upstream": readinessUpstream,
    "profile-readiness-result": readinessResult,
    "run-profile-readiness": readinessButton
  };
  const metadata = [
    {
      initialized: true,
      name: "gsc",
      version: "3",
      defaultProfile: "google-work",
      profiles: [{ name: "google-work" }],
      upstreams: [{ name: "default" }],
      authentication: {
        mode: "provider-adapter",
        readinessTargets: [{ profile: "google-work", upstream: "default" }]
      }
    },
    { initialized: false, catalog: { discoveryState: "ready", configurations: [{ id: "gsc", name: "gsc" }] } }
  ];
  const requests: string[] = [];
  runInNewContext(javascript, {
    document: {
      getElementById(id: string): unknown {
        return elements[id];
      },
      createElement(): FakeElement {
        return new FakeElement();
      }
    },
    HTMLFormElement: FakeForm,
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
    HTMLButtonElement: FakeButton,
    HTMLTextAreaElement: FakeTextArea,
    HTMLElement: FakeElement,
    Element: FakeElement,
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async (path: unknown) => {
      const requestPath = String(path);
      requests.push(requestPath);
      const data = requestPath === "/api/v1/sessions"
        ? { csrfToken: "test-csrf" }
        : requestPath === "/api/v1/config"
          ? metadata.shift()
          : requestPath === "/api/v1/health"
            ? { audit: { state: "healthy" } }
            : [];
      return { ok: true, status: requestPath === "/api/v1/sessions" ? 201 : 200, json: async () => ({ data }) };
    }
  });

  const unlock = unlockForm.listeners.get("submit");
  if (unlock === undefined) throw new Error("Expected the Console unlock handler.");
  await unlock({ preventDefault: () => undefined });
  const visibleAfterSelection = readinessView.hidden === false;
  await unlock({ preventDefault: () => undefined });
  const hiddenAfterUnselection = readinessView.hidden === true;
  const runReadiness = readinessButton.listeners.get("click");
  if (runReadiness === undefined) throw new Error("Expected the profile readiness handler.");
  await runReadiness();
  return {
    visibleAfterSelection,
    hiddenAfterUnselection,
    readinessRequestsAfterUnselection: requests.filter((path) => path === "/api/v1/profile-readiness").length
  };
}

async function submitMultiAccountGscPresetForm(
  javascript: string,
  options: { readonly firstProfileName?: string } = {}
): Promise<{ readonly request?: Record<string, unknown>; readonly status: string }> {
  type SubmitListener = (event: { readonly preventDefault: () => void }) => void | Promise<void>;
  class FakeElement {
    readonly dataset: Record<string, string> = {};
    textContent = "";

    addEventListener(name: string, listener: unknown): void {
      void name;
      void listener;
    }

    append(): void {}

    replaceChildren(): void {}

    querySelectorAll(selector?: string): readonly unknown[] {
      void selector;
      return [];
    }
  }
  class FakeInput extends FakeElement {
    required = false;

    constructor(readonly value: string) {
      super();
    }
  }
  class FakeProfileRow extends FakeElement {
    constructor(
      private readonly name: FakeInput,
      private readonly description: FakeInput,
      private readonly clientSecrets: FakeInput
    ) {
      super();
    }

    querySelector(selector: string): unknown {
      if (selector === "[data-gsc-profile-name]") return this.name;
      if (selector === "[data-gsc-profile-description]") return this.description;
      if (selector === "[data-gsc-client-secrets-file]") return this.clientSecrets;
      return undefined;
    }
  }
  class FakeAccountList extends FakeElement {
    constructor(readonly rows: readonly FakeProfileRow[]) {
      super();
    }

    querySelectorAll(selector: string): readonly unknown[] {
      return selector === "[data-gsc-profile-row]" ? this.rows : [];
    }
  }
  class FakeForm extends FakeElement {
    readonly listeners = new Map<string, SubmitListener>();
    readonly values: Record<string, string> = {
      name: "gsc",
      preset: "google-search-console",
      defaultProfile: "google-craftmyletter"
    };

    addEventListener(name: string, listener: SubmitListener): void {
      this.listeners.set(name, listener);
    }

    reset(): void {}
  }
  class FakeSelect extends FakeElement {
    readonly listeners = new Map<string, () => void>();

    constructor(public value: string) {
      super();
    }

    addEventListener(name: string, listener: () => void): void {
      this.listeners.set(name, listener);
    }
  }
  class FakeFormData {
    constructor(private readonly form: FakeForm) {}

    get(name: string): string | null {
      return this.form.values[name] ?? null;
    }
  }

  const form = new FakeForm();
  const selection = new FakeSelect("google-search-console");
  const defaultProfile = new FakeSelect("google-craftmyletter");
  const status = new FakeElement();
  const accounts = new FakeAccountList([
    new FakeProfileRow(
      new FakeInput(options.firstProfileName ?? "google-govalidate"),
      new FakeInput("GoValidate Google account"),
      new FakeInput("/tmp/govalidate-client-secrets.json")
    ),
    new FakeProfileRow(
      new FakeInput("google-craftmyletter"),
      new FakeInput("CraftMyLetter Google account"),
      new FakeInput("/tmp/craftmyletter-client-secrets.json")
    )
  ]);
  const requests: Array<{ readonly path: string; readonly body?: string }> = [];
  runInNewContext(javascript, {
    document: {
      getElementById(id: string): unknown {
        if (id === "status") return status;
        if (id === "preset-onboarding-form") return form;
        if (id === "preset-selection") return selection;
        if (id === "gsc-account-list") return accounts;
        if (id === "gsc-default-profile") return defaultProfile;
        return undefined;
      },
      createElement: () => new FakeElement()
    },
    HTMLFormElement: FakeForm,
    HTMLSelectElement: FakeSelect,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLButtonElement: class {},
    HTMLTextAreaElement: class {},
    Element: class {},
    FormData: FakeFormData,
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async (path: unknown, options?: { readonly body?: unknown }) => {
      const requestPath = String(path);
      requests.push({
        path: requestPath,
        ...(typeof options?.body === "string" ? { body: options.body } : {})
      });
      return {
        ok: true,
        status: 200,
        json: async () => requestPath === "/api/v1/config"
          ? { data: { initialized: false } }
          : { data: {} }
      };
    }
  });

  const submit = form.listeners.get("submit");
  if (submit === undefined) throw new Error("Expected the preset setup submit handler.");
  await submit({ preventDefault: () => undefined });

  const request = requests.find((entry) => entry.path === "/api/v1/onboarding/preset");
  return {
    ...(request?.body === undefined ? {} : { request: JSON.parse(request.body) as Record<string, unknown> }),
    status: status.textContent
  };
}

function observePresetFieldConstraintState(javascript: string): {
  readonly initial: Record<string, unknown>;
  readonly googleSearchConsole: Record<string, unknown>;
  readonly genericAfterGoogleSearchConsole: Record<string, unknown>;
} {
  class FakeElement {
    readonly dataset: Record<string, string> = {};
    readonly listeners = new Map<string, () => void>();
    id = "";
    hidden = false;

    addEventListener(name: string, listener: unknown): void {
      if (typeof listener === "function") this.listeners.set(name, listener as () => void);
    }

    append(): void {}

    replaceChildren(): void {}

    querySelectorAll(selector?: string): readonly unknown[] {
      void selector;
      return [];
    }
  }
  class FakeInput extends FakeElement {
    disabled = false;
    required = true;

    constructor(public value: string, readonly name = "") {
      super();
    }
  }
  class FakeSelect extends FakeElement {
    disabled = false;
    required = true;

    constructor(public value: string) {
      super();
    }
  }
  class FakeProfileRow extends FakeElement {
    constructor(
      private readonly name: FakeInput,
      private readonly description: FakeInput,
      private readonly clientSecrets: FakeInput
    ) {
      super();
    }

    querySelector(selector: string): unknown {
      if (selector === "[data-gsc-profile-name]") return this.name;
      if (selector === "[data-gsc-profile-description]") return this.description;
      if (selector === "[data-gsc-client-secrets-file]") return this.clientSecrets;
      return undefined;
    }
  }
  class FakeAccountList extends FakeElement {
    constructor(readonly rows: readonly FakeProfileRow[]) {
      super();
    }

    querySelectorAll(selector: string): readonly unknown[] {
      return selector === "[data-gsc-profile-row]" ? this.rows : [];
    }
  }
  class FakePresetField extends FakeElement {
    constructor(readonly controls: readonly (FakeInput | FakeSelect)[]) {
      super();
      this.dataset.presetField = "google-search-console";
    }

    querySelectorAll(selector: string): readonly unknown[] {
      if (selector === "input") return this.controls.filter((control): control is FakeInput => control instanceof FakeInput);
      if (selector === "input, select, textarea") return this.controls;
      return [];
    }
  }
  class FakeForm extends FakeElement {
    constructor(readonly fields: readonly FakePresetField[]) {
      super();
    }

    querySelectorAll(selector: string): readonly unknown[] {
      return selector === "[data-preset-field]" ? this.fields : [];
    }

    reset(): void {}
  }

  const profileName = new FakeInput("google-work");
  const description = new FakeInput("Work Google account");
  const clientSecrets = new FakeInput("/tmp/work-client-secrets.json");
  const defaultProfile = new FakeSelect("google-work");
  profileName.dataset.gscProfileName = "true";
  clientSecrets.dataset.gscClientSecretsFile = "true";
  defaultProfile.id = "gsc-default-profile";
  const field = new FakePresetField([profileName, description, clientSecrets, defaultProfile]);
  const form = new FakeForm([field]);
  const selection = new FakeSelect("generic");
  const accounts = new FakeAccountList([new FakeProfileRow(profileName, description, clientSecrets)]);
  runInNewContext(javascript, {
    document: {
      getElementById(id: string): unknown {
        if (id === "preset-onboarding-form") return form;
        if (id === "preset-selection") return selection;
        if (id === "gsc-account-list") return accounts;
        if (id === "gsc-default-profile") return defaultProfile;
        return undefined;
      },
      createElement: () => new FakeElement()
    },
    HTMLFormElement: FakeForm,
    HTMLSelectElement: FakeSelect,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLButtonElement: FakeElement,
    HTMLTextAreaElement: class {},
    Element: FakeElement
  });

  const controls = () => ({
    fieldHidden: field.hidden,
    profileName: { required: profileName.required, disabled: profileName.disabled },
    description: { required: description.required, disabled: description.disabled },
    clientSecrets: { required: clientSecrets.required, disabled: clientSecrets.disabled },
    defaultProfile: { required: defaultProfile.required, disabled: defaultProfile.disabled }
  });
  const initial = controls();
  selection.value = "google-search-console";
  selection.listeners.get("change")?.();
  const googleSearchConsole = controls();
  selection.value = "generic";
  selection.listeners.get("change")?.();
  return { initial, googleSearchConsole, genericAfterGoogleSearchConsole: controls() };
}

describe("local Console control server", () => {
  it("serves a navigation-safe local dashboard shell without exposing bootstrap credentials", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("content-security-policy")).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
        "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      );
      const html = await page.text();
      expect(html).toContain("Miftah Console");
      expect(html).toContain('src="/app.js"');
      expect(html).toContain('href="/app.css"');
      expect(html).toContain("Remote native OAuth");
      expect(html).toContain("Provider adapter");
      expect(html).toContain("Upstream-owned auth");
      expect(html).toContain("Unsupported state");
      expect(html).toContain("Set up an MCP");
      expect(html).toContain('id="setup-source-choice"');
      expect(html).toContain('type="radio" name="setup-source"');
      expect(html).toContain('data-setup-source="connector"');
      expect(html).toContain('data-setup-source="remote"');
      expect(html).toContain('data-setup-source="local"');
      expect(html).toContain('data-setup-source="browser-sign-in"');
      expect(html).toContain('data-setup-source="import"');
      expect(html).not.toContain('aria-pressed=');
      expect(html).toContain("Local executable + argument array");
      expect(html).toContain("Remote HTTPS MCP endpoint");
      expect(html).toContain('id="native-oauth-setup-link"');
      expect(html).toContain("Remote MCP with browser sign-in");
      expect(html).toContain("Check sign-in and create profile");
      expect(html).toContain("Miftah checks this exact HTTPS endpoint for supported browser sign-in before it creates the configuration.");
      expect(html).toContain("Discover OAuth from configured upstream");
      expect(html).toContain("Add another native OAuth account");
      expect(html).toContain('id="provider-account-editor"');
      expect(html).toContain("Add another provider account");
      expect(html).toContain('id="environment-profile-editor"');
      expect(html).toContain("Add another environment-backed account");
      expect(html).toContain("It does not read the credential, start this upstream, or copy a provider token cache.");
      expect(html).toContain("Advanced manual OAuth registration");
      expect(html).toContain("acceptLocalCommand");
      expect(html).toContain('id="preset-onboarding-view"');
      expect(html).toContain('id="client-entry-onboarding-view"');
      expect(html).toContain('id="client-entry-onboarding-form"');
      expect(html).toContain("Import one MCP client entry");
      expect(html).not.toContain("Import one local stdio MCP");
      expect(html).toContain("static launch grammar");
      expect(html).toContain("credential-free HTTPS remote entry");
      expect(html).toContain("explicitly marked <code>type:");
      expect(html).toContain("Remote import does not discover OAuth or call the endpoint.");
      expect(html).toContain("advanced manual setup");
      expect(html).toContain('id="client-entry-manual-local"');
      expect(html).toContain('id="client-entry-manual-remote"');
      expect(html).toContain("Miftah does not retain rejected arguments, headers, environment values, or credentials.");
      expect(html).toContain('id="gsc-account-list"');
      expect(html).toContain('id="gsc-default-profile"');
      expect(html).toContain("Active vs durable:");
      expect(html).toContain('id="default-profile-editor"');
      expect(html).toContain('id="default-profile-selection"');
      expect(html).toContain('id="set-default-profile"');
      expect(html).toContain("Choose which account new MCP sessions start with");
      expect(html).toContain('id="profile-description-editor"');
      expect(html).toContain('id="profile-description-selection"');
      expect(html).toContain('id="set-profile-description"');
      expect(html).toContain('id="clear-profile-description"');
      expect(html).toContain("Edit a non-secret account label");
      expect(html).toContain('id="profile-removal-editor"');
      expect(html).toContain('id="profile-removal-selection"');
      expect(html).toContain('id="profile-removal-replacement"');
      expect(html).toContain('id="confirm-profile-removal"');
      expect(html).toContain('id="remove-profile"');
      expect(html).toContain("Remove an account safely");
      expect(html).toContain('id="profile-inventory-list"');
      expect(html).toContain("Configured accounts");
      expect(html).toContain('id="configuration-catalog-view"');
      expect(html).toContain('id="provider-authentication-view"');
      expect(html).toContain('id="profile-readiness-view"');
      expect(html).toContain('id="profile-readiness-profile"');
      expect(html).toContain('id="profile-readiness-upstream"');
      expect(html).toContain('id="run-profile-readiness"');
      expect(html).toContain("Run reviewed safe check");
      expect(html).toContain('id="setup-completion-view"');
      expect(html).toContain("Finish setup without guessing");
      expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
      expect(html).not.toContain("test-only-bootstrap-credential");
      expect(html).not.toContain("localStorage");

      const script = await fetch(new URL("/app.js", server.url));
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      const javascript = await script.text();
      expect(javascript).toContain("/api/v1/sessions");
      expect(javascript).toContain("/api/v1/onboarding/native-oauth/discover");
      expect(javascript).toContain("native-oauth-setup-link");
      expect(javascript).toContain("/api/v1/connections/discover");
      expect(javascript).toContain("/api/v1/profiles/native-oauth/discover");
      expect(javascript).toContain("/api/v1/profiles/provider-account");
      expect(javascript).toContain("/api/v1/profiles/environment-account");
      expect(javascript).toContain("/api/v1/onboarding/preset");
      expect(javascript).toContain("renderSetupCompletion");
      expect(javascript).toContain("function selectSetupSource(source)");
      expect(javascript).toContain("setup-source-choice");
      expect(javascript).toContain('querySelectorAll("input[data-setup-source]")');
      expect(javascript).toContain('setupSourceChoice.addEventListener("change"');
      expect(javascript).toContain("local-stdio");
      expect(javascript).toContain("acceptLocalCommand");
      expect(javascript).toContain("/api/v1/onboarding/client-entry");
      expect(javascript).toContain('bindClientEntryManualRecoveryAction("client-entry-manual-local", "local")');
      expect(javascript).toContain('bindClientEntryManualRecoveryAction("client-entry-manual-remote", "remote")');
      expect(triggerClientEntryManualRecoveryAction(javascript, "client-entry-manual-local", "local")).toEqual({
        selected: ["local"],
        documentCleared: true
      });
      expect(triggerClientEntryManualRecoveryAction(javascript, "client-entry-manual-remote", "remote")).toEqual({
        selected: ["remote"],
        documentCleared: true
      });
      expect(selectConsoleRemoteSetupSource(javascript)).toEqual({
        preset: "streamable-http",
        updateCalls: 1,
        focused: true,
        status: "Enter the generic HTTPS endpoint below. Miftah does not discover authentication or call it during this setup."
      });
      await expect(submitPresetFormWithStaleValue(javascript)).resolves.toEqual({
        name: "analytics",
        preset: "generic",
        credentialEnv: "ANALYTICS_TOKEN"
      });
      await expect(submitPresetFormWithStaleValue(javascript, {
        name: "local-tools",
        preset: "local-stdio",
        localCommand: "node",
        args: "server.mjs\n\n--stdio\n$pageview",
        cwd: "/Users/example/local-tools",
        credentialEnv: "LOCAL_MCP_TOKEN",
        acceptLocalCommand: "true"
      })).resolves.toEqual({
        name: "local-tools",
        preset: "local-stdio",
        localCommand: "node",
        args: ["server.mjs", "", "--stdio", "$pageview"],
        cwd: "/Users/example/local-tools",
        credentialEnv: "LOCAL_MCP_TOKEN",
        acceptLocalCommand: true
      });
      await expect(submitMultiAccountGscPresetForm(javascript)).resolves.toMatchObject({
        request: {
          name: "gsc",
          preset: "google-search-console",
          googleSearchConsoleProfiles: [
            {
              name: "google-govalidate",
              description: "GoValidate Google account",
              oauthClientSecretsFile: "/tmp/govalidate-client-secrets.json"
            },
            {
              name: "google-craftmyletter",
              description: "CraftMyLetter Google account",
              oauthClientSecretsFile: "/tmp/craftmyletter-client-secrets.json"
            }
          ],
          defaultProfile: "google-craftmyletter"
        }
      });
      await expect(submitMultiAccountGscPresetForm(javascript, {
        firstProfileName: "Google account"
      })).resolves.toEqual({
        status: "Each Google Search Console profile name must use lowercase letters, digits, or hyphens."
      });
      expect(observePresetFieldConstraintState(javascript)).toEqual({
        initial: {
          fieldHidden: true,
          profileName: { required: false, disabled: true },
          description: { required: false, disabled: true },
          clientSecrets: { required: false, disabled: true },
          defaultProfile: { required: false, disabled: true }
        },
        googleSearchConsole: {
          fieldHidden: false,
          profileName: { required: true, disabled: false },
          description: { required: false, disabled: false },
          clientSecrets: { required: true, disabled: false },
          defaultProfile: { required: true, disabled: false }
        },
        genericAfterGoogleSearchConsole: {
          fieldHidden: true,
          profileName: { required: false, disabled: true },
          description: { required: false, disabled: true },
          clientSecrets: { required: false, disabled: true },
          defaultProfile: { required: false, disabled: true }
        }
      });
      expect(javascript).toContain("/api/v1/client-snippets");
      expect(javascript).toContain("/api/v1/configurations/");
      expect(javascript).toContain("/api/v1/profile-readiness");
      expect(javascript).toContain("/api/v1/profiles/default");
      expect(javascript).toContain('body: { profile: profile.value }');
      expect(javascript).toContain("/api/v1/profiles/description");
      expect(javascript).toContain("renderProfileDescriptionEditor");
      expect(javascript).toContain("/api/v1/profiles/remove");
      expect(javascript).toContain("renderProfileRemovalEditor");
      expect(preserveProfileDescriptionSelectionAcrossRefresh(javascript)).toEqual({
        profile: "personal",
        description: "Personal account"
      });
      expect(clearProfileReadinessResultOnTargetChange(javascript)).toEqual({
        afterProfileChange: "",
        afterUpstreamChange: ""
      });
      await expect(clearProfileReadinessStateWhenConfigurationIsUnselected(javascript)).resolves.toEqual({
        visibleAfterSelection: true,
        hiddenAfterUnselection: true,
        readinessRequestsAfterUnselection: 0
      });
      expect(javascript).toContain("Running the reviewed safe check");
      expect(javascript).toContain("renderProfileInventory");
      expect(javascript).toContain("profile.value = defaultProfile");
      expect(javascript).toContain('body: { profile: profile.value, upstream: upstream.value }');
      expect(javascript).toContain("provider-adapter");
      expect(javascript).toContain("This provider owns its browser login");
      expect(javascript).toContain('const providerAccountEditor = byId("provider-account-editor");');
      expect(javascript).toContain("authentication.accountAddition");
      expect(javascript).toContain("Adding the provider-owned account");
      expect(javascript).toContain('const environmentProfileEditor = byId("environment-profile-editor");');
      expect(javascript).toContain("authentication.environmentProfileAddition");
      expect(javascript).toContain("Adding the environment-backed account without reading its credential or launching the upstream");
      expect(javascript).toContain('const nativeOAuthAccountEditor = byId("native-oauth-account-editor");');
      expect(javascript).toContain("if (nativeOAuthAccountEditor) nativeOAuthAccountEditor.hidden = !nativeOAuth;");
      expect(javascript).toContain('action === "credential" ? "DELETE" : "POST"');
      expect(javascript).toContain("statusErrorCode");
      expect(javascript).toContain("restoreUnlock");
      expect(javascript).not.toMatch(/innerHTML|localStorage|sessionStorage|\beval\s*\(/u);

      const stylesheet = await fetch(new URL("/app.css", server.url));
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(await stylesheet.text()).toContain("prefers-reduced-motion");

      const hostileHost = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: server.url.hostname,
            port: server.url.port,
            path: "/",
            method: "GET",
            headers: { host: "attacker.example.test" }
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          }
        );
        request.once("error", reject);
        request.end();
      });
      expect(hostileHost).toBe(403);

      const mutation = await fetch(server.url, { method: "POST" });
      expect(mutation.status).toBe(405);
    } finally {
      await server.close();
    }
  });

  describe("first-run native OAuth HTTP flow", () => {
    let configPath: string;

    beforeEach(async () => {
      const root = await mkdtemp(join(tmpdir(), "miftah-console-dashboard-"));
      temporaryDirectories.push(root);
      const privateParent = await createPrivateConsoleDirectory(root);
      // The endpoint must create this directory itself: the Windows helper
      // rejects an existing directory rather than inheriting an unknown ACL.
      configPath = join(privateParent, "miftah", "miftah.json");
    });

    it("discovers endpoint-first OAuth before a CSRF-protected first-run setup and copy-only client snippets", async () => {
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const server = await startConsoleServer(configPath, {
      bootstrapCredential: "test-only-bootstrap-credential",
      allowMissingConfig: true,
      application: new ConsoleApplicationService(configPath, {
        nativeOAuthFetch: upstream.fetch,
        launcher: { command: process.execPath, args: [join(process.cwd(), "dist", "cli", "main.js"), "serve"] }
      })
    });

    try {
      const session = await bootstrapSession(server);
      const metadata = await fetch(new URL("/api/v1/config", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toEqual({
        data: { initialized: false, restartRequiredForExistingClients: true }
      });

      const endpoint = new URL("/api/v1/onboarding/native-oauth/discover", server.url);
      const request = {
        name: "posthog-work",
        profile: "production",
        description: "Production account",
        resource: upstream.streamableHttpUrl
      };
      const missingCsrf = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(missingCsrf.status).toBe(403);
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const secretBearing = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ...request, accessToken: "must-not-be-accepted" })
      });
      expect(secretBearing.status).toBe(422);
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const insecureEndpoint = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ...request, resource: "http://mcp.example.test/mcp" })
      });
      expect(insecureEndpoint.status).toBe(422);
      expect(await insecureEndpoint.json()).toEqual({
        error: { code: "validation_error", message: "The request body is invalid." }
      });
      await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const created = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        data: { profile: "production", upstream: "default", resource: "https://mcp.example.test/mcp" }
      });
      expect(upstream.discoveryRequests()).toEqual([
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-authorization-server"
      ]);
      expect(upstream.registrationRequests()).toEqual([]);

      const snippets = await fetch(new URL("/api/v1/client-snippets?client=claude-desktop", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(snippets.status).toBe(200);
      const snippetBody = await snippets.json() as {
        data: Array<{ client: string; json: string }>;
      };
      expect(snippetBody).toMatchObject({ data: [{ client: "claude-desktop" }] });
      const snippetConfig = JSON.parse(snippetBody.data[0]?.json ?? "") as {
        mcpServers: Record<string, { args: string[] }>;
      };
      expect(snippetConfig.mcpServers["posthog-work"]?.args).toContain(configPath);
      expect(JSON.stringify(snippetBody)).not.toContain("auth.example.test");
    } finally {
      await server.close();
      await upstream.close();
    }
    });

    it("does not write a configuration when endpoint-first OAuth lacks dynamic registration", async () => {
      const discoveryFetch: typeof globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.toString() === "https://mcp.example.test/.well-known/oauth-protected-resource/mcp") {
          return new Response("not found", { status: 404 });
        }
        if (url.toString() === "https://mcp.example.test/.well-known/oauth-protected-resource") {
          return Response.json({
            resource: "https://mcp.example.test/mcp",
            authorization_servers: ["https://auth.example.test"],
            scopes_supported: ["analytics:read"]
          });
        }
        if (url.toString() === "https://auth.example.test/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: "https://auth.example.test",
            authorization_endpoint: "https://auth.example.test/authorize",
            token_endpoint: "https://auth.example.test/token",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
            client_id_metadata_document_supported: true,
            authorization_response_iss_parameter_supported: true
          });
        }
        throw new Error(`unexpected URL ${url}`);
      };
      const server = await startConsoleServer(configPath, {
        bootstrapCredential: "test-only-bootstrap-credential",
        allowMissingConfig: true,
        application: new ConsoleApplicationService(configPath, { nativeOAuthFetch: discoveryFetch })
      });

      try {
        const session = await bootstrapSession(server);
        const response = await fetch(new URL("/api/v1/onboarding/native-oauth/discover", server.url), {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            name: "posthog-work",
            profile: "production",
            resource: "https://mcp.example.test/mcp"
          })
        });
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({
          error: {
            code: "oauth_client_registration_unsupported",
            message: "The endpoint does not support automatic OAuth setup. Use its documented manual registration details."
          }
        });
        await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await server.close();
      }
    });

    it("supports a CSRF-protected first-run known connector setup without accepting raw secrets", async () => {
      const server = await startConsoleServer(configPath, {
        bootstrapCredential: "test-only-bootstrap-credential",
        allowMissingConfig: true
      });

      try {
        const session = await bootstrapSession(server);
        const endpoint = new URL("/api/v1/onboarding/preset", server.url);
        const request = {
          name: "support-tools",
          ...supportedKnownConnectorOptions()
        };
        const missingCsrf = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "content-type": "application/json"
          },
          body: JSON.stringify(request)
        });
        expect(missingCsrf.status).toBe(403);
        await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        const secretBearing = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({ ...request, accessToken: "must-not-be-accepted" })
        });
        expect(secretBearing.status).toBe(422);
        await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        const created = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify(request)
        });
        expect(created.status).toBe(201);
        expect(await created.json()).toEqual({
          data: {
            changed: true,
            write: true,
            name: "support-tools",
            defaultProfile: "default",
            profileCount: 1,
            actions: [`Created Miftah configuration 'support-tools' from preset '${request.preset}'.`],
            completion: {
              verification: {
                state: "not-declared",
                message: "No provider-declared safe check is available for this configuration, so Miftah did not run or invent one."
              },
              clientHandoff: {
                state: "available",
                message:
                  "Next: generate a copy-only client snippet below, review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
              }
            }
          }
        });
        expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
          name: "support-tools",
          profiles: { default: { env: { SUPPORT_TOKEN: "${SUPPORT_TOKEN}" } } }
        });
      } finally {
        await server.close();
      }
    });

    it("requires explicit acknowledgement before the first-run API stores a local stdio argument array", async () => {
      const server = await startConsoleServer(configPath, {
        bootstrapCredential: "test-only-bootstrap-credential",
        allowMissingConfig: true
      });

      try {
        const session = await bootstrapSession(server);
        const endpoint = new URL("/api/v1/onboarding/preset", server.url);
        const localCommand = process.platform === "win32" ? process.execPath : "node";
        const request = {
          name: "local-tools",
          preset: "local-stdio",
          localCommand,
          args: ["server.mjs", "--stdio", "$pageview"],
          cwd: tmpdir(),
          credentialEnv: "LOCAL_MCP_TOKEN",
          acceptLocalCommand: true
        };

        const missingAcknowledgement = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({ ...request, acceptLocalCommand: undefined })
        });
        expect(missingAcknowledgement.status).toBe(422);
        await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        const created = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify(request)
        });
        expect(created.status).toBe(201);
        expect(await created.json()).toEqual({
          data: {
            changed: true,
            write: true,
            name: "local-tools",
            defaultProfile: "default",
            profileCount: 1,
            actions: ["Created Miftah configuration 'local-tools' from preset 'local-stdio'."],
            completion: {
              verification: {
                state: "not-declared",
                message: "No provider-declared safe check is available for this configuration, so Miftah did not run or invent one."
              },
              clientHandoff: {
                state: "available",
                message:
                  "Next: generate a copy-only client snippet below, review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
              }
            }
          }
        });
        expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
          upstream: { transport: "stdio", command: localCommand, args: ["server.mjs", "--stdio", "$pageview"] },
          profiles: { default: { env: { LOCAL_MCP_TOKEN: "${LOCAL_MCP_TOKEN}" }, policy: "readonly" } },
          tooling: { unknownToolRisk: "destructive" }
        });
      } finally {
        await server.close();
      }
    });

    it("imports one selected local stdio client entry through a CSRF-protected no-secret endpoint", async () => {
      const server = await startConsoleServer(configPath, {
        bootstrapCredential: "test-only-bootstrap-credential",
        allowMissingConfig: true
      });

      try {
        const session = await bootstrapSession(server);
        const endpoint = new URL("/api/v1/onboarding/client-entry", server.url);
        const secret = "gF7r2Uv9Qx";
        const missingCsrf = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            name: "posthog-work",
            entry: "posthog",
            document: JSON.stringify({ mcpServers: { posthog: { command: "npx" } } })
          })
        });
        expect(missingCsrf.status).toBe(403);
        await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        for (const argument of [
          `--custom-header=Authorization: Bearer ${secret}`,
          `--metadata=Authorization: Bearer ${secret}`,
          `--metadata=Bearer ${secret}`,
          `--url=https://user:${secret}@example.test/mcp`,
          `--url=redis://:${secret}@cache.example/0`,
          `--url=https://${secret}@example.test/mcp`,
          `--metadata=Token ${secret}`,
          `--myApiKey=${secret}`,
          `--token-value=${secret}`,
          `--endpoint=https://example.test/mcp?token=${secret}`,
          `--jwt=${secret}`,
          `--metadata=JWT ${secret}`,
          `--url=https://example.test/mcp?signature=${secret}`,
          `--url=https://example.test/mcp?sig=${secret}`
        ]) {
          const unsafe = await fetch(endpoint, {
            method: "POST",
            headers: {
              origin: server.url.origin,
              cookie: session.cookie,
              "x-miftah-csrf": session.csrfToken,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              name: "posthog-work",
              entry: "posthog",
              document: JSON.stringify({
                mcpServers: {
                  posthog: { command: "npx", args: [argument] }
                }
              })
            })
          });
          expect(unsafe.status).toBe(422);
          expect(await unsafe.text()).not.toContain(secret);
          await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }

        for (const command of [
          `https://${secret}@example.test/mcp`,
          `node?token=${secret}`
        ]) {
          const unsafe = await fetch(endpoint, {
            method: "POST",
            headers: {
              origin: server.url.origin,
              cookie: session.cookie,
              "x-miftah-csrf": session.csrfToken,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              name: "posthog-work",
              entry: "posthog",
              document: JSON.stringify({
                mcpServers: { posthog: { command } }
              })
            })
          });
          expect(unsafe.status).toBe(422);
          expect(await unsafe.text()).not.toContain(secret);
          await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }

        for (const unsafeEntry of [
          { command: "env", args: [`FOO=${secret}`, "node", "server.mjs"] },
          { command: "node", args: ["-e", `require("./server").start("${secret}")`] },
          { command: "python3", args: ["-c", `start("${secret}")`] },
          { command: "npx", args: ["--yes", "@posthog/mcp"] }
        ]) {
          const unsafe = await fetch(endpoint, {
            method: "POST",
            headers: {
              origin: server.url.origin,
              cookie: session.cookie,
              "x-miftah-csrf": session.csrfToken,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              name: "posthog-work",
              entry: "posthog",
              document: JSON.stringify({ mcpServers: { posthog: unsafeEntry } })
            })
          });
          expect(unsafe.status).toBe(422);
          expect(await unsafe.text()).not.toContain(secret);
          await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }

        const advancedManual = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            name: "posthog-work",
            entry: "posthog",
            document: JSON.stringify({
              mcpServers: {
                posthog: {
                  command: "npx",
                  args: ["--yes", "@posthog/mcp@1.2.3", "--project", "craftmyletter"]
                }
              }
            })
          })
        });
        expect(advancedManual.status).toBe(422);
        const advancedManualBody = await advancedManual.json();
        expect(advancedManualBody).toEqual({
          error: {
            code: "client_entry_static_launch_unsupported",
            message: "This entry needs manual transport setup. Miftah did not import it or write a configuration. It did not retain its arguments, headers, environment values, or credentials. Re-enter a reviewed executable and literal arguments, or a canonical HTTPS endpoint; configure authentication separately."
          }
        });
        expect(JSON.stringify(advancedManualBody)).not.toContain("--project");
        expect(JSON.stringify(advancedManualBody)).not.toContain("craftmyletter");
        await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        const entry = importableClientEntry();
        const created = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            name: "posthog-work",
            entry: "posthog",
            document: JSON.stringify({
              mcpServers: {
                posthog: entry
              }
            })
          })
        });
        expect(created.status).toBe(201);
        expect(await created.json()).toEqual({
          data: {
            changed: true,
            write: true,
            name: "posthog-work",
            defaultProfile: "default",
            profileCount: 1,
            actions: ["Created Miftah configuration 'posthog-work' from one selected local stdio client entry."],
            completion: {
              verification: {
                state: "not-declared",
                message: "No provider-declared safe check is available for this configuration, so Miftah did not run or invent one."
              },
              clientHandoff: {
                state: "available",
                message:
                  "Next: generate a copy-only client snippet below, review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
              }
            }
          }
        });
        expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
          name: "posthog-work",
          profiles: { default: { policy: "readonly" } }
        });
      } finally {
        await server.close();
      }
    });

    it("imports one selected HTTPS remote client entry through the same CSRF-protected no-secret endpoint", async () => {
      const server = await startConsoleServer(configPath, {
        bootstrapCredential: "test-only-bootstrap-credential",
        allowMissingConfig: true
      });

      try {
        const session = await bootstrapSession(server);
        const response = await fetch(new URL("/api/v1/onboarding/client-entry", server.url), {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            name: "remote-analytics",
            entry: "analytics",
            document: JSON.stringify({
              mcpServers: {
                analytics: { type: "http", url: "https://mcp.example.test/mcp" }
              }
            })
          })
        });

        expect(response.status).toBe(201);
        expect(await response.json()).toEqual({
          data: {
            changed: true,
            write: true,
            name: "remote-analytics",
            defaultProfile: "default",
            profileCount: 1,
            actions: [
              "Created Miftah configuration 'remote-analytics' from one selected HTTPS remote client entry without OAuth discovery or an upstream call."
            ],
            completion: {
              verification: {
                state: "not-declared",
                message: "No provider-declared safe check is available for this configuration, so Miftah did not run or invent one."
              },
              clientHandoff: {
                state: "available",
                message:
                  "Next: generate a copy-only client snippet below, review it, merge it manually, then restart or reconnect the client. Miftah did not modify any client file."
              }
            }
          }
        });
        expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
          upstream: { transport: "streamable-http", url: "https://mcp.example.test/mcp" },
          profiles: { default: { policy: "readonly" } },
          tooling: { unknownToolRisk: "destructive" }
        });
      } finally {
        await server.close();
      }
    });

    it("accepts a maximum-sized client document even when its JSON request envelope is larger than 64 KiB", async () => {
      const server = await startConsoleServer(configPath, {
        bootstrapCredential: "test-only-bootstrap-credential",
        allowMissingConfig: true
      });

      try {
        const session = await bootstrapSession(server);
        const endpoint = new URL("/api/v1/onboarding/client-entry", server.url);
        const entry = JSON.stringify({ mcpServers: { example: importableClientEntry() } });
        const document = `${entry}${" ".repeat(64 * 1024 - Buffer.byteLength(entry, "utf8"))}`;
        const request = {
          name: "maximum-document",
          entry: "example",
          document
        };
        expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeGreaterThan(64 * 1024);

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify(request)
        });

        expect(response.status).toBe(201);
        expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ name: "maximum-document" });
      } finally {
        await server.close();
      }
    });

    it("honors an explicitly configured request-size cap for client-entry onboarding", async () => {
      const server = await startConsoleServer(configPath, {
        bootstrapCredential: "test-only-bootstrap-credential",
        allowMissingConfig: true,
        maximumRequestBytes: 32
      });

      try {
        const session = await bootstrapSession(server);
        const response = await fetch(new URL("/api/v1/onboarding/client-entry", server.url), {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            name: "too-large",
            entry: "example",
            document: JSON.stringify({ mcpServers: { example: { command: "node" } } })
          })
        });

        expect(response.status).toBe(413);
        await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await server.close();
      }
    });

    it("accepts only structured multi-account GSC setup data", async () => {
      const server = await startConsoleServer(configPath, {
        bootstrapCredential: "test-only-bootstrap-credential",
        allowMissingConfig: true
      });

      try {
        const session = await bootstrapSession(server);
        const endpoint = new URL("/api/v1/onboarding/preset", server.url);
        const request = {
          name: "gsc",
          preset: "google-search-console",
          googleSearchConsoleProfiles: [
            {
              name: "google-govalidate",
              description: "GoValidate Google account",
              oauthClientSecretsFile: "/tmp/govalidate-client-secrets.json"
            },
            {
              name: "google-craftmyletter",
              description: "CraftMyLetter Google account",
              oauthClientSecretsFile: "/tmp/craftmyletter-client-secrets.json"
            }
          ],
          defaultProfile: "google-craftmyletter"
        };
        const secretBearing = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            ...request,
            googleSearchConsoleProfiles: [{ ...request.googleSearchConsoleProfiles[0], accessToken: "must-not-be-accepted" }]
          })
        });
        expect(secretBearing.status).toBe(422);
        await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        const missingDefault = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            name: request.name,
            preset: request.preset,
            googleSearchConsoleProfiles: request.googleSearchConsoleProfiles
          })
        });
        expect(missingDefault.status).toBe(422);
        await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        const created = await fetch(endpoint, {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify(request)
        });
        expect(created.status).toBe(201);
        expect(await created.json()).toMatchObject({
          data: { name: "gsc", defaultProfile: "google-craftmyletter", profileCount: 2 }
        });
        const config = JSON.parse(await readFile(configPath, "utf8")) as {
          readonly profiles: Record<string, {
            readonly env: {
              readonly GSC_CONFIG_DIR: string;
              readonly GSC_OAUTH_CLIENT_SECRETS_FILE?: string;
            };
          }>;
        };
        expect(config.profiles).toMatchObject({
          "google-govalidate": { env: { GSC_OAUTH_CLIENT_SECRETS_FILE: "/tmp/govalidate-client-secrets.json" } },
          "google-craftmyletter": { env: { GSC_OAUTH_CLIENT_SECRETS_FILE: "/tmp/craftmyletter-client-secrets.json" } }
        });
        expect(new Set(Object.values(config.profiles).map((profile) => profile.env.GSC_CONFIG_DIR)).size).toBe(2);
      } finally {
        await server.close();
      }
    });
  });

  it("requires a CSRF-protected selection before a no-config dashboard opens a discovered configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-catalog-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const gscPath = join(directory, "gsc.json");
    await writePrivateConsoleFile(gscPath, `${JSON.stringify({
      version: "3",
      name: "gsc",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { work: {} }
    })}\n`);

    const server = await startConsoleServer(join(directory, "miftah.json"), {
      bootstrapCredential: "test-only-bootstrap-credential",
      allowMissingConfig: true,
      launcher: { command: process.execPath, args: ["serve"] },
      application: new ConsoleDashboardApplicationService({
        defaultConfigPath: join(directory, "miftah.json"),
        configDirectory: directory,
        launcher: { command: process.execPath, args: ["serve"] }
      })
    });

    try {
      const session = await bootstrapSession(server);
      const initial = await fetch(new URL("/api/v1/config", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(initial.status).toBe(200);
      const initialBody = await initial.json() as {
        data: { initialized: boolean; catalog?: { configurations: Array<{ id: string; name: string }> } };
      };
      expect(initialBody.data.initialized).toBe(false);
      expect(initialBody.data.catalog?.configurations).toHaveLength(1);
      expect(JSON.stringify(initialBody)).not.toContain(directory);
      const id = initialBody.data.catalog?.configurations[0]?.id;
      if (id === undefined) throw new Error("Expected a discovered configuration id.");

      const catalog = await fetch(new URL("/api/v1/configurations", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(catalog.status).toBe(200);
      expect(await catalog.json()).toMatchObject({ data: { configurations: [{ id, name: "gsc" }] } });

      const selection = new URL(`/api/v1/configurations/${encodeURIComponent(id)}/select`, server.url);
      const missingCsrf = await fetch(selection, {
        method: "POST",
        headers: { origin: server.url.origin, cookie: session.cookie, "content-type": "application/json" },
        body: "{}"
      });
      expect(missingCsrf.status).toBe(403);

      const selected = await fetch(selection, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(selected.status).toBe(200);
      expect(await selected.json()).toMatchObject({
        data: {
          initialized: true,
          name: "gsc",
          authentication: { mode: "provider-adapter", provider: "Google Search Console" },
          catalog: { selectedConfigurationId: id }
        }
      });

      const explicit = await startConsoleServer(gscPath, { bootstrapCredential: "another-test-bootstrap-credential" });
      try {
        const explicitSession = await bootstrapSession(explicit);
        const noCatalog = await fetch(new URL("/api/v1/configurations", explicit.url), {
          headers: { origin: explicit.url.origin, cookie: explicitSession.cookie }
        });
        expect(noCatalog.status).toBe(404);
      } finally {
        await explicit.close();
      }
    } finally {
      await server.close();
    }
  });

  it("does not let an invalid default path hide another safe discovered configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-invalid-default-"));
    temporaryDirectories.push(root);
    const directory = await createPrivateConsoleDirectory(root);
    const defaultPath = join(directory, "miftah.json");
    await writePrivateConsoleFile(defaultPath, "{not valid json");
    const gscPath = join(directory, "gsc.json");
    await writePrivateConsoleFile(gscPath, `${JSON.stringify({
      version: "3",
      name: "gsc",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { work: {} }
    })}\n`);

    const server = await startConsoleServer(defaultPath, {
      bootstrapCredential: "test-only-bootstrap-credential",
      allowMissingConfig: true,
      deferConfigValidation: true,
      application: new ConsoleDashboardApplicationService({
        defaultConfigPath: defaultPath,
        configDirectory: directory
      })
    });
    try {
      const session = await bootstrapSession(server);
      const response = await fetch(new URL("/api/v1/config", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { initialized: false, catalog: { configurations: [{ name: "gsc" }] } }
      });
    } finally {
      await server.close();
    }
  });

  it("reports an unavailable local client launcher as a stable service-availability error", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const session = await bootstrapSession(server);
      const response = await fetch(new URL("/api/v1/client-snippets?client=claude-desktop", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "console_launcher_unavailable",
          message: "Client snippets are unavailable because the Console launcher is not configured."
        }
      });
    } finally {
      await server.close();
    }
  });

  it("requires an invocation-bound bootstrap before returning redacted control metadata", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      expect(server.url.hostname).toBe("127.0.0.1");
      expect(server.url.pathname).toBe("/");

      const unauthenticated = await fetch(new URL("/api/v1/health", server.url), {
        headers: { origin: server.url.origin }
      });
      expect(unauthenticated.status).toBe(401);

      const missingOrigin = await fetch(new URL("/api/v1/health", server.url));
      expect(missingOrigin.status).toBe(401);

      const bootstrapUrl = new URL("/api/v1/sessions", server.url);
      const hostileHost = await rawPost(
        bootstrapUrl,
        {
          host: "attacker.example.test",
          origin: server.url.origin,
          authorization: "Bootstrap test-only-bootstrap-credential",
          "content-type": "application/json"
        },
        "{}"
      );
      expect(hostileHost.status).toBe(403);

      const hostileOrigin = await fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          origin: "https://attacker.example.test",
          authorization: "Bootstrap test-only-bootstrap-credential",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(hostileOrigin.status).toBe(403);

      const mcpBearer = await fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          authorization: "Bearer test-only-bootstrap-credential",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(mcpBearer.status).toBe(401);

      const bootstrap = await fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          authorization: "Bootstrap test-only-bootstrap-credential",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(bootstrap.status).toBe(201);
      const cookie = bootstrap.headers.get("set-cookie");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      const bootstrapBody = await bootstrap.json() as { readonly data: { readonly csrfToken: string } };
      expect(bootstrapBody.data.csrfToken).toMatch(/^[A-Za-z0-9_-]{32,}$/u);
      expect(JSON.stringify(bootstrapBody)).not.toContain("test-only-bootstrap-credential");
      expect(bootstrap.headers.get("x-frame-options")).toBe("DENY");

      const health = await fetch(new URL("/api/v1/health", server.url), {
        headers: { cookie: cookie!.split(";", 1)[0]! }
      });
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        data: {
          status: "ok",
          config: { name: "console-test", version: "1" },
          audit: { enabled: true, state: "healthy" },
          restartRequiredForExistingClients: true
        }
      });
    } finally {
      await server.close();
    }
  });

  it("requires CSRF proof and schema validation before an atomic audited connection mutation", async () => {
    const configPath = await writeOAuthConfig();
    const server = await startConsoleServer(configPath, { bootstrapCredential: "test-only-bootstrap-credential" });
    const connectionRef = "oauthconn:31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c";

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/connections", server.url);
      const request = {
        connectionRef,
        profile: "personal",
        upstream: "default",
        issuer: "https://auth.example.test",
        clientRegistration: "dynamic",
        scopes: ["read"]
      };
      const missingCsrf = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(missingCsrf.status).toBe(403);
      expect(await readFile(configPath, "utf8")).not.toContain(connectionRef);

      const invalid = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ...request, scopes: "read", unexpected: true })
      });
      expect(invalid.status).toBe(422);
      expect(await readFile(configPath, "utf8")).not.toContain(connectionRef);

      const created = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json();
      expect(createdBody).toMatchObject({
        data: { changed: true, write: true, connectionRef }
      });
      expect(JSON.stringify(createdBody)).not.toContain(configPath);
      expect(JSON.stringify(createdBody)).not.toContain("miftah-backup");
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        oauth: { connections: { [connectionRef]: { profile: "personal", scopes: ["read"] } } }
      });

      const audit = await fetch(new URL("/api/v1/audit?limit=10", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(audit.status).toBe(200);
      const auditBody = await audit.json() as { readonly data: readonly Record<string, unknown>[] };
      expect(auditBody.data).toContainEqual(expect.objectContaining({
        operation: "console/oauth-connection-add",
        status: "success",
        profile: "personal",
        upstream: "default"
      }));
      expect(JSON.stringify(auditBody)).not.toContain("dynamic");
      expect(JSON.stringify(auditBody)).not.toContain("auth.example.test");

      const metadata = await fetch(new URL("/api/v1/config", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({
        data: {
          name: "console-oauth-test",
          version: "3",
          defaultProfile: "personal",
          profiles: [
            { name: "personal", description: "Personal account" },
            { name: "work" }
          ],
          upstreams: [{ name: "default", transport: "streamable-http" }],
          restartRequiredForExistingClients: true
        }
      });

      const profiles = await fetch(new URL("/api/v1/profiles", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(profiles.status).toBe(200);
      expect(await profiles.json()).toMatchObject({ data: [{ name: "personal" }, { name: "work" }] });

      const connections = await fetch(new URL("/api/v1/connections", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(connections.status).toBe(200);
      const connectionsBody = await connections.json() as { readonly data: unknown };
      expect(connectionsBody.data).toEqual([
        expect.objectContaining({ connectionRef, profile: "personal", upstream: "default" })
      ]);
      expect(JSON.stringify(connectionsBody)).not.toContain("accessToken");
      expect(JSON.stringify(connectionsBody)).not.toContain("refreshToken");

      const mcpRoute = await fetch(new URL("/mcp", server.url), {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(mcpRoute.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("derives OAuth connection metadata from an existing configured upstream without accepting browser-supplied OAuth fields", async () => {
    const configPath = await writeOAuthConfig();
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const server = await startConsoleServer(configPath, {
      bootstrapCredential: "test-only-bootstrap-credential",
      application: new ConsoleApplicationService(configPath, {
        generateConnectionRef: () => "31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c",
        nativeOAuthFetch: upstream.fetch
      })
    });

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/connections/discover", server.url);
      const request = { profile: "personal", upstream: "default" };
      const missingCsrf = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(missingCsrf.status).toBe(403);
      expect(await readFile(configPath, "utf8")).not.toContain("oauthconn:");

      const injectedMetadata = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...request,
          resource: "https://attacker.example.test/mcp",
          issuer: "https://attacker.example.test",
          clientRegistration: "pre-registered",
          scopes: ["admin"],
          accessToken: "must-not-be-accepted"
        })
      });
      expect(injectedMetadata.status).toBe(422);
      expect(await readFile(configPath, "utf8")).not.toContain("oauthconn:");

      const created = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        data: {
          connectionRef: "oauthconn:31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c",
          profile: "personal",
          upstream: "default",
          resource: "https://mcp.example.test/mcp"
        }
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        oauth: {
          connections: {
            "oauthconn:31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c": {
              issuer: "https://mcp.example.test",
              clientRegistration: "dynamic",
              scopes: ["mcp:tools"]
            }
          }
        }
      });
      expect(upstream.registrationRequests()).toEqual([]);
    } finally {
      await server.close();
      await upstream.close();
    }
  });

  it("adds a new endpoint-discovered OAuth account profile without accepting endpoint or issuer metadata from the browser", async () => {
    const configPath = await writeOAuthConfig();
    const upstream = await startOAuthCompatibilityProbe({ publicBaseUrl: "https://mcp.example.test" });
    const server = await startConsoleServer(configPath, {
      bootstrapCredential: "test-only-bootstrap-credential",
      application: new ConsoleApplicationService(configPath, {
        generateConnectionRef: () => "67e7cc2b-f812-4b2f-8c0d-bec84f570ab3",
        nativeOAuthFetch: upstream.fetch
      })
    });

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/profiles/native-oauth/discover", server.url);
      const request = {
        profile: "personal-2",
        description: "Second personal account",
        upstream: "default",
        makeDefault: true
      };
      const invalid = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ...request,
          resource: "https://attacker.example.test/mcp",
          issuer: "https://attacker.example.test",
          clientRegistration: "pre-registered",
          scopes: ["admin"]
        })
      });
      expect(invalid.status).toBe(422);
      expect(await readFile(configPath, "utf8")).not.toContain("personal-2");

      const created = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        data: {
          connectionRef: "oauthconn:67e7cc2b-f812-4b2f-8c0d-bec84f570ab3",
          profile: "personal-2",
          upstream: "default",
          resource: "https://mcp.example.test/mcp"
        }
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultProfile: "personal-2",
        profiles: { "personal-2": { description: "Second personal account" } },
        oauth: {
          connections: {
            "oauthconn:67e7cc2b-f812-4b2f-8c0d-bec84f570ab3": {
              profile: "personal-2",
              issuer: "https://mcp.example.test",
              scopes: ["mcp:tools"]
            }
          }
        }
      });
      expect(upstream.registrationRequests()).toEqual([]);
    } finally {
      await server.close();
      await upstream.close();
    }
  });

  it("adds a provider-owned account only through a strict CSRF-protected GSC lifecycle request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-provider-account-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "gsc.json");
    const firstSecrets = join(directory, "google-work-client-secrets.json");
    const secondSecrets = join(directory, "google-personal-client-secrets.json");
    const thirdSecrets = join(directory, "google-third-client-secrets.json");
    await writeFile(configPath, `${JSON.stringify(buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", oauthClientSecretsFile: firstSecrets },
        { name: "google-personal", oauthClientSecretsFile: secondSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath }), null, 2)}\n`, { mode: 0o600 });
    const server = await startConsoleServer(configPath, { bootstrapCredential: "test-only-bootstrap-credential" });

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/profiles/provider-account", server.url);
      const request = {
        profile: "google-third",
        description: "Third Google account",
        credentialFile: thirdSecrets,
        makeDefault: true
      };
      const rejected = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ...request, accessToken: "must-not-be-accepted" })
      });
      expect(rejected.status).toBe(422);
      expect(await readFile(configPath, "utf8")).not.toContain("google-third");

      const created = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(created.status).toBe(201);
      const payload = await created.json() as { readonly data: Record<string, unknown> };
      expect(payload.data).toMatchObject({
        adapter: "Google Search Console",
        profile: "google-third",
        actions: [
          "Created provider-owned account profile 'google-third'.",
          "Set durable default profile to 'google-third'."
        ]
      });
      expect(JSON.stringify(payload)).not.toContain(thirdSecrets);
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        readonly defaultProfile: string;
        readonly profiles: Record<string, { readonly env: { readonly GSC_CONFIG_DIR: string } }>;
      };
      expect(config.defaultProfile).toBe("google-third");
      expect(new Set(Object.values(config.profiles).map((profile) => profile.env.GSC_CONFIG_DIR)).size).toBe(3);
    } finally {
      await server.close();
    }
  });

  it("adds a static environment-backed account only through a strict CSRF-protected Console request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-environment-account-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "sentry.json");
    await writeFile(configPath, `${JSON.stringify(environmentProfileConfig("sentry"), null, 2)}\n`, { mode: 0o600 });
    const server = await startConsoleServer(configPath, { bootstrapCredential: "test-only-bootstrap-credential" });

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/profiles/environment-account", server.url);
      const request = {
        profile: "govalidate",
        description: "GoValidate Sentry account",
        credentialEnv: "STATIC_GOVALIDATE_ACCESS_TOKEN",
        makeDefault: true
      };
      const rejected = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ ...request, accessToken: "must-not-be-accepted" })
      });
      expect(rejected.status).toBe(422);
      expect(await readFile(configPath, "utf8")).not.toContain("govalidate");

      const created = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });
      expect(created.status).toBe(201);
      const payload = await created.json() as { readonly data: Record<string, unknown> };
      expect(payload.data).toEqual({
        changed: true,
        write: true,
        profile: "govalidate",
        actions: [
          "Created environment-backed account profile 'govalidate'.",
          "Enabled required profile-switch confirmation.",
          "Required explicit selection for destructive tools.",
          "Set durable default profile to 'govalidate'."
        ]
      });
      expect(JSON.stringify(payload)).not.toContain("STATIC_GOVALIDATE_ACCESS_TOKEN");
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultProfile: "govalidate",
        profiles: {
          govalidate: {
            description: "GoValidate Sentry account",
            env: { STATIC_ACCESS_TOKEN: "${STATIC_GOVALIDATE_ACCESS_TOKEN}" },
            policy: "readonly"
          }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("changes the durable default profile only through a strict CSRF-protected Console request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-default-profile-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "gsc.json");
    const workSecrets = join(directory, "google-work-client-secrets.json");
    const personalSecrets = join(directory, "google-personal-client-secrets.json");
    await writeFile(configPath, `${JSON.stringify(buildPresetConfig("gsc", "google-search-console", {
      googleSearchConsoleProfiles: [
        { name: "google-work", oauthClientSecretsFile: workSecrets },
        { name: "google-personal", oauthClientSecretsFile: personalSecrets }
      ],
      defaultProfile: "google-work"
    }, { configurationPath: configPath }), null, 2)}\n`, { mode: 0o600 });
    const before = JSON.parse(await readFile(configPath, "utf8")) as { readonly profiles: unknown };
    const server = await startConsoleServer(configPath, { bootstrapCredential: "test-only-bootstrap-credential" });

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/profiles/default", server.url);
      const rejected = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "google-personal", credentialFile: personalSecrets })
      });
      expect(rejected.status).toBe(422);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ defaultProfile: "google-work" });

      const changed = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "google-personal" })
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({
        data: {
          changed: true,
          write: true,
          profile: "google-personal",
          actions: ["Set durable default profile to 'google-personal'."]
        }
      });
      const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
        readonly defaultProfile: string;
        readonly profiles: unknown;
      };
      expect(persisted.defaultProfile).toBe("google-personal");
      expect(persisted.profiles).toEqual(before.profiles);
    } finally {
      await server.close();
    }
  });

  it("sets or explicitly clears a profile description only through a strict CSRF-protected Console request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-profile-description-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "analytics.json");
    await writeFile(configPath, `${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: ["provider.mjs"] },
      profiles: {
        work: { description: "Work account", env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { description: "Personal account", env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    }, null, 2)}\n`, { mode: 0o600 });
    const before = JSON.parse(await readFile(configPath, "utf8")) as { readonly profiles: unknown; readonly defaultProfile: string };
    const server = await startConsoleServer(configPath, { bootstrapCredential: "test-only-bootstrap-credential" });

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/profiles/description", server.url);
      const formattingRejected = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal", description: " Personal Search Console " })
      });
      expect(formattingRejected.status).toBe(422);
      expect(await formattingRejected.json()).toEqual({
        error: {
          code: "profile_description_input_invalid",
          message: "Choose a trimmed non-secret profile description or explicitly clear it."
        }
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(before);

      const rejected = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal", description: "Personal", clearDescription: true })
      });
      expect(rejected.status).toBe(422);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(before);

      const changed = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal", description: "Personal Search Console" })
      });
      expect(changed.status).toBe(200);
      const changedPayload = await changed.json() as { readonly data: Record<string, unknown> };
      expect(changedPayload.data).toEqual({
        changed: true,
        write: true,
        profile: "personal",
        actions: ["Set profile description for 'personal'."]
      });
      expect(JSON.stringify(changedPayload)).not.toContain("Personal Search Console");
      const updated = JSON.parse(await readFile(configPath, "utf8")) as {
        readonly defaultProfile: string;
        readonly profiles: {
          readonly work: unknown;
          readonly personal: { readonly description?: string; readonly env: unknown };
        };
      };
      expect(updated.defaultProfile).toBe("work");
      expect(updated.profiles.work).toEqual((before.profiles as { readonly work: unknown }).work);
      expect(updated.profiles.personal).toEqual({
        description: "Personal Search Console",
        env: { API_KEY: "${PERSONAL_API_KEY}" }
      });

      const cleared = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal", clearDescription: true })
      });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toEqual({
        data: {
          changed: true,
          write: true,
          profile: "personal",
          actions: ["Cleared profile description for 'personal'."]
        }
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultProfile: "work",
        profiles: {
          work: (before.profiles as { readonly work: unknown }).work,
          personal: { env: { API_KEY: "${PERSONAL_API_KEY}" } }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("removes a profile only through a strict CSRF-protected Console request and keeps OAuth-bound profiles fail-closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-profile-removal-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "analytics.json");
    await writeFile(configPath, `${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: process.execPath, args: ["provider.mjs"] },
      profiles: {
        work: { env: { API_KEY: "${WORK_API_KEY}" } },
        personal: { env: { API_KEY: "${PERSONAL_API_KEY}" } }
      }
    }, null, 2)}\n`, { mode: 0o600 });
    const before = JSON.parse(await readFile(configPath, "utf8"));
    const server = await startConsoleServer(configPath, { bootstrapCredential: "test-only-bootstrap-credential" });

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/profiles/remove", server.url);
      const rejected = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal", credential: "never-accepted" })
      });
      expect(rejected.status).toBe(422);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual(before);

      const changed = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal" })
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({
        data: {
          changed: true,
          write: true,
          profile: "personal",
          actions: ["Removed profile 'personal'."]
        }
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultProfile: "work",
        profiles: { work: { env: { API_KEY: "${WORK_API_KEY}" } } }
      });
    } finally {
      await server.close();
    }
  });

  it("returns a safe explicit refusal when a requested removal has a configured native OAuth binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-profile-removal-oauth-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "analytics.json");
    await writeFile(configPath, `${JSON.stringify({
      version: "3",
      name: "analytics",
      defaultProfile: "work",
      upstream: { transport: "streamable-http", url: "https://mcp.example.com/mcp" },
      profiles: { work: {}, personal: {} },
      oauth: {
        connections: {
          "oauthconn:11111111-1111-4111-8111-111111111111": {
            profile: "work",
            upstream: "default",
            resource: "https://mcp.example.com/mcp",
            issuer: "https://auth.example.com",
            clientRegistration: "dynamic",
            scopes: ["openid"]
          }
        }
      }
    }, null, 2)}\n`, { mode: 0o600 });
    const original = await readFile(configPath, "utf8");
    const server = await startConsoleServer(configPath, { bootstrapCredential: "test-only-bootstrap-credential" });

    try {
      const session = await bootstrapSession(server);
      const response = await fetch(new URL("/api/v1/profiles/remove", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "work", replacementProfile: "personal" })
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: {
          code: "profile_removal_oauth_connection",
          message: "This account has a native OAuth binding. Miftah refuses to split configuration removal from OS-vault cleanup."
        }
      });
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await server.close();
    }
  });

  it("accepts every existing non-empty configuration profile name when changing the durable default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-default-profile-name-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    await writeFile(configPath, `${JSON.stringify({
      version: "1",
      name: "console-default-profile-name",
      defaultProfile: "personal",
      upstream: { transport: "stdio", command: process.execPath, args: ["provider.mjs"] },
      profiles: { personal: {}, "client_1": {} }
    }, null, 2)}\n`, { mode: 0o600 });
    const server = await startConsoleServer(configPath, { bootstrapCredential: "test-only-bootstrap-credential" });

    try {
      const session = await bootstrapSession(server);
      const changed = await fetch(new URL("/api/v1/profiles/default", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "client_1" })
      });

      expect(changed.status).toBe(200);
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ defaultProfile: "client_1" });
    } finally {
      await server.close();
    }
  });

  it("rejects endpoint-first OAuth for a non-HTTPS Streamable HTTP upstream with a safe client error", async () => {
    const configPath = await writeConfig();
    const original = await readFile(configPath, "utf8");
    const server = await startConsoleServer(configPath, {
      bootstrapCredential: "test-only-bootstrap-credential",
      application: new ConsoleApplicationService(configPath)
    });

    try {
      const session = await bootstrapSession(server);
      const response = await fetch(new URL("/api/v1/connections/discover", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal", upstream: "default" })
      });

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: {
          code: "oauth_resource_invalid",
          message: "The MCP endpoint must be an exact HTTPS Streamable HTTP URL."
        }
      });
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await server.close();
    }
  });

  it("audits exact connection lifecycle mutations only after CSRF validation", async () => {
    const calls: string[] = [];
    const application: ConsoleControlApplication = {
      health: async () => ({
        status: "ok",
        config: { name: "console-test", version: "1" },
        audit: { enabled: true, state: "healthy" },
        restartRequiredForExistingClients: true
      }),
      configMetadata: async () => ({
        initialized: true,
        name: "console-test",
        version: "1",
        defaultProfile: "personal",
        profiles: [],
        upstreams: [],
        oauthConnectionCount: 0,
        restartRequiredForExistingClients: true
      }),
      listConnections: async () => [],
      onboardNativeOAuth: async () => {
        throw new MiftahError("CONFIG_CREATE_FAILED", "CONFIG_CREATE_FAILED: test fixture");
      },
      clientSnippets: async () => [],
      connectionStatus: async (connectionRef) => ({ connectionRef, credentialState: "missing" }),
      addConnection: async () => { throw new Error("not used"); },
      connect: async (connectionRef) => {
        calls.push(`connect:${connectionRef}`);
        return { ok: true, connectionRef };
      },
      reauth: async (connectionRef) => {
        calls.push(`reauth:${connectionRef}`);
        return { ok: true, connectionRef };
      },
      disconnect: async (connectionRef) => {
        calls.push(`disconnect:${connectionRef}`);
        return { connectionRef, credentialState: "missing" };
      },
      testConnection: async (connectionRef) => {
        calls.push(`test:${connectionRef}`);
        return { ok: true, connectionRef };
      },
      auditRecords: async () => []
    };
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential",
      application
    });

    try {
      const session = await bootstrapSession(server);
      const createFailure = await fetch(new URL("/api/v1/onboarding/native-oauth", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "service",
          profile: "work",
          resource: "https://mcp.example.test/mcp",
          issuer: "https://auth.example.test",
          clientRegistration: "dynamic",
          scopes: []
        })
      });
      expect(createFailure.status).toBe(503);
      expect(await createFailure.json()).toEqual({
        error: {
          code: "config_create_failed",
          message: "The initial configuration could not be created."
        }
      });

      const reference = "oauthconn:31cb3ef5-22cb-4bf7-9ebf-e4a2d32bf18c";
      const status = await fetch(
        new URL(`/api/v1/connections/${encodeURIComponent(reference)}`, server.url),
        { headers: { origin: server.url.origin, cookie: session.cookie } }
      );
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ data: { connectionRef: reference, credentialState: "missing" } });
      const connectUrl = new URL(`/api/v1/connections/${encodeURIComponent(reference)}/connect`, server.url);
      const rejected = await fetch(connectUrl, {
        method: "POST",
        headers: { origin: server.url.origin, cookie: session.cookie, "content-type": "application/json" },
        body: "{}"
      });
      expect(rejected.status).toBe(403);
      expect(calls).toEqual([]);

      for (const [action, method] of [
        ["connect", "POST"],
        ["reauth", "POST"],
        ["test", "POST"],
        ["credential", "DELETE"]
      ] as const) {
        const response = await fetch(
          new URL(`/api/v1/connections/${encodeURIComponent(reference)}/${action}`, server.url),
          {
            method,
            headers: {
              origin: server.url.origin,
              cookie: session.cookie,
              "x-miftah-csrf": session.csrfToken,
              "content-type": "application/json"
            },
            body: "{}"
          }
        );
        expect(response.status).toBe(200);
      }
      expect(calls).toEqual([
        `connect:${reference}`,
        `reauth:${reference}`,
        `test:${reference}`,
        `disconnect:${reference}`
      ]);
    } finally {
      await server.close();
    }
  });

  it("exposes profile readiness only through a strict CSRF-protected Console action", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "profile-readiness-bootstrap-credential"
    });
    try {
      const session = await bootstrapSession(server);
      const url = new URL("/api/v1/profile-readiness", server.url);
      const missingCsrf = await fetch(url, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal" })
      });
      expect(missingCsrf.status).toBe(403);

      const invalidBody = await fetch(url, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal", unexpected: true })
      });
      expect(invalidBody.status).toBe(422);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal" })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: {
          status: "unsupported",
          profile: "personal",
          safeRead: { status: "unavailable", errorCode: "PROFILE_READINESS_UNSUPPORTED" }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("passes a request-bound cancellation signal to the profile readiness service", async () => {
    let receivedSignal: AbortSignal | undefined;
    const readiness = vi.spyOn(ConsoleApplicationService.prototype, "profileReadiness").mockImplementation(async (request) => {
      receivedSignal = request.signal;
      return {
        status: "unsupported",
        profile: request.profile,
        upstream: request.upstream ?? "default",
        safeRead: { status: "unavailable", errorCode: "PROFILE_READINESS_UNSUPPORTED" },
        identity: { status: "not-checked" }
      };
    });
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "profile-readiness-cancellation-bootstrap-credential"
    });
    try {
      const session = await bootstrapSession(server);
      const response = await fetch(new URL("/api/v1/profile-readiness", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "personal", upstream: "default" })
      });
      expect(response.status).toBe(200);
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(receivedSignal?.aborted).toBe(false);
    } finally {
      readiness.mockRestore();
      await server.close();
    }
  });

  it("bounds requests, expires sessions, rotates local credentials, and shuts down cleanly", async () => {
    let now = 10_000;
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "first-test-bootstrap-credential",
      maximumRequestBytes: 32,
      bootstrapTtlMs: 100,
      idleSessionMs: 100,
      absoluteSessionMs: 1_000,
      now: () => now
    });

    const firstUrl = new URL("/api/v1/sessions", server.url);
    const oversized = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: "Bootstrap first-test-bootstrap-credential",
        "content-type": "application/json"
      },
      body: JSON.stringify({ padding: "x".repeat(64) })
    });
    expect(oversized.status).toBe(413);

    now += 101;
    const staleBootstrap = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: "Bootstrap first-test-bootstrap-credential",
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(staleBootstrap.status).toBe(401);

    const activeBootstrap = server.rotateCredential();
    const activeBootstrapResponse = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: `Bootstrap ${activeBootstrap}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(activeBootstrapResponse.status).toBe(201);
    const activeBody = await activeBootstrapResponse.json() as { readonly data: { readonly csrfToken: string } };
    const activeCookie = activeBootstrapResponse.headers.get("set-cookie")?.split(";", 1)[0];
    if (activeCookie === undefined) throw new Error("Expected an active Console session cookie.");
    const session = { cookie: activeCookie, csrfToken: activeBody.data.csrfToken };
    const replay = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: `Bootstrap ${activeBootstrap}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(replay.status).toBe(401);

    now += 101;
    const expired = await fetch(new URL("/api/v1/health", server.url), {
      headers: { origin: server.url.origin, cookie: session.cookie }
    });
    expect(expired.status).toBe(401);

    const replacement = server.rotateCredential();
    expect(replacement).not.toBe(activeBootstrap);
    const replacementSession = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: `Bootstrap ${replacement}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(replacementSession.status).toBe(201);

    await server.close();
    await expect(fetch(new URL("/api/v1/health", server.url), {
      headers: { origin: server.url.origin }
    })).rejects.toThrow();
  });

  it("rate-limits the local API and applies a stricter bootstrap-attempt budget", async () => {
    let now = 50_000;
    const requestLimited = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "request-rate-bootstrap-credential",
      maximumRequestsPerMinute: 2,
      now: () => now
    });
    try {
      const session = await bootstrapSession(requestLimited);
      const first = await fetch(new URL("/api/v1/health", requestLimited.url), {
        headers: { origin: requestLimited.url.origin, cookie: session.cookie }
      });
      expect(first.status).toBe(200);
      const limited = await fetch(new URL("/api/v1/health", requestLimited.url), {
        headers: { origin: requestLimited.url.origin, cookie: session.cookie }
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
    } finally {
      await requestLimited.close();
    }

    const bootstrapLimited = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "bootstrap-rate-test-credential",
      maximumRequestsPerMinute: 100,
      maximumBootstrapAttemptsPerMinute: 2,
      now: () => now
    });
    try {
      const url = new URL("/api/v1/sessions", bootstrapLimited.url);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const rejected = await fetch(url, {
          method: "POST",
          headers: {
            origin: bootstrapLimited.url.origin,
            authorization: "Bootstrap invalid-bootstrap-credential",
            "content-type": "application/json"
          },
          body: "{}"
        });
        expect(rejected.status).toBe(401);
      }
      const limited = await fetch(url, {
        method: "POST",
        headers: {
          origin: bootstrapLimited.url.origin,
          authorization: "Bootstrap bootstrap-rate-test-credential",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(limited.status).toBe(429);

      now += 60_000;
      const recovered = await fetch(url, {
        method: "POST",
        headers: {
          origin: bootstrapLimited.url.origin,
          authorization: "Bootstrap bootstrap-rate-test-credential",
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(recovered.status).toBe(201);
    } finally {
      await bootstrapLimited.close();
    }
  });
});
