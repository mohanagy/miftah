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
import { FileSetupDraftStore } from "../src/setup/setup-draft.js";
import {
  createPrivateConsoleDirectory,
  writePrivateConsoleFile
} from "./helpers/private-console-directory.js";
import { environmentProfileConfig } from "./helpers/environment-profile-config.js";
import { createMemoryProfileRenameOAuthDependencies } from "./helpers/profile-rename-oauth-dependencies.js";
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
  vi.unstubAllEnvs();
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
          : requestPath === "/api/v1/onboarding/preset/preview"
            ? {
                data: {
                  configuration: {
                    sensitiveValues: "omitted",
                    publication: "new-file-only",
                    name: "analytics",
                    defaultProfile: "default",
                    profileCount: 1,
                    profiles: ["default"],
                    upstreams: [{ name: "default", kind: "local-process", transport: "stdio" }]
                  }
                }
              }
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

  const request = requests.find((entry) => entry.path === "/api/v1/onboarding/preset/preview");
  if (request?.body === undefined) throw new Error("Expected a preset onboarding request.");
  return JSON.parse(request.body) as Record<string, unknown>;
}

async function reviewThenCreatePresetForm(
  javascript: string,
  reviewOptions: {
    readonly changeDuringPreview?: boolean;
    readonly doubleCreate?: boolean;
    readonly editDuringCreate?: boolean;
    readonly failFirstCreate?: boolean;
    readonly profileCountMismatch?: boolean;
    readonly profileCountValue?: unknown;
    readonly omitProfileCount?: boolean;
    readonly reReviewDuringCreate?: boolean;
    readonly unsafeReview?: boolean;
  } = {}
): Promise<{
  readonly requests: readonly { readonly path: string; readonly body?: string }[];
  readonly reviewVisibleAfterSubmit: boolean;
  readonly createEnabledAfterSubmit: boolean;
  readonly createEnabledAfterChange: boolean;
  readonly createEnabledAfterFailure?: boolean;
  readonly reviewEditDisabledDuringCreate?: boolean;
  readonly reviewText: readonly string[];
  readonly statusText?: string;
}> {
  type Listener = (event?: { readonly preventDefault: () => void }) => void | Promise<void>;
  class FakeElement {
    readonly listeners = new Map<string, Listener>();
    readonly children: FakeElement[] = [];
    hidden = false;
    textContent = "";

    addEventListener(name: string, listener: Listener): void {
      this.listeners.set(name, listener);
    }

    append(...children: FakeElement[]): void {
      this.children.push(...children);
    }

    replaceChildren(...children: FakeElement[]): void {
      this.children.splice(0, this.children.length, ...children);
    }

    querySelectorAll(): readonly unknown[] {
      return [];
    }
  }
  class FakeButton extends FakeElement {
    disabled = false;

    async click(): Promise<void> {
      if (this.disabled) return;
      await this.listeners.get("click")?.();
    }
  }
  class FakeForm extends FakeElement {
    readonly values: Record<string, string> = {
      name: "analytics",
      preset: "generic",
      credentialEnv: "ANALYTICS_TOKEN"
    };

    reset(): void {}

    querySelector(): undefined {
      return undefined;
    }
  }
  class FakeSelect extends FakeElement {
    constructor(public value: string) {
      super();
    }
  }
  class FakeFormData {
    constructor(private readonly form: FakeForm) {}

    get(name: string): string | null {
      return this.form.values[name] ?? null;
    }
  }

  const form = new FakeForm();
  const selection = new FakeSelect("generic");
  const reviewView = new FakeElement();
  const reviewSummary = new FakeElement();
  const reviewDetails = new FakeElement();
  const create = new FakeButton();
  const edit = new FakeButton();
  const status = new FakeElement();
  const requests: Array<{ readonly path: string; readonly body?: string }> = [];
  type FakeResponse = {
    readonly ok: boolean;
    readonly status: number;
    readonly json: () => Promise<{
      readonly data?: Record<string, unknown>;
      readonly error?: { readonly code: string; readonly message: string };
    }>;
  };
  const hasProfileCountValue = Object.prototype.hasOwnProperty.call(reviewOptions, "profileCountValue");
  const previewConfiguration: Record<string, unknown> = {
    sensitiveValues: reviewOptions.unsafeReview === true ? "included" : "omitted",
    publication: "new-file-only",
    name: "analytics",
    defaultProfile: "default",
    profiles: ["default"],
    upstreams: [{ name: "default", kind: "local-process", transport: "stdio" }]
  };
  if (!reviewOptions.omitProfileCount) {
    previewConfiguration.profileCount = hasProfileCountValue
      ? reviewOptions.profileCountValue
      : reviewOptions.profileCountMismatch === true ? 3 : 1;
  }
  const previewData: Record<string, unknown> = { configuration: previewConfiguration };
  const response = (data: Record<string, unknown>): FakeResponse => ({
    ok: true,
    status: 200,
    json: async () => ({ data })
  });
  let resolveDelayedPreview: ((value: FakeResponse) => void) | undefined;
  const resolveDelayedCreates: Array<(value: FakeResponse) => void> = [];
  let firstCreateFailed = false;
  runInNewContext(javascript, {
    document: {
      getElementById(id: string): unknown {
        if (id === "status") return status;
        if (id === "preset-onboarding-form") return form;
        if (id === "preset-selection") return selection;
        if (id === "preset-review-view") return reviewView;
        if (id === "preset-review-summary") return reviewSummary;
        if (id === "preset-review-details") return reviewDetails;
        if (id === "preset-create-reviewed") return create;
        if (id === "preset-review-edit") return edit;
        return undefined;
      },
      createElement: () => new FakeElement(),
      querySelectorAll: () => []
    },
    HTMLFormElement: FakeForm,
    HTMLSelectElement: FakeSelect,
    HTMLElement: FakeElement,
    HTMLInputElement: class {},
    HTMLButtonElement: FakeButton,
    HTMLTextAreaElement: class {},
    Element: class {},
    FormData: FakeFormData,
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async (path: unknown, requestOptions?: { readonly body?: unknown }) => {
      const requestPath = String(path);
      requests.push({
        path: requestPath,
        ...(typeof requestOptions?.body === "string" ? { body: requestOptions.body } : {})
      });
      if (requestPath === "/api/v1/onboarding/preset/preview" && reviewOptions.changeDuringPreview === true) {
        return await new Promise<FakeResponse>((resolve) => { resolveDelayedPreview = resolve; });
      }
      if (
        requestPath === "/api/v1/onboarding/preset"
        && (reviewOptions.doubleCreate === true || reviewOptions.editDuringCreate === true || reviewOptions.reReviewDuringCreate === true)
      ) {
        return await new Promise<FakeResponse>((resolve) => { resolveDelayedCreates.push(resolve); });
      }
      if (requestPath === "/api/v1/onboarding/preset" && reviewOptions.failFirstCreate === true && !firstCreateFailed) {
        firstCreateFailed = true;
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: {
              code: "config_exists",
              message: "Configuration already exists."
            }
          })
        };
      }
      return requestPath === "/api/v1/onboarding/preset/preview"
        ? response(previewData)
        : requestPath === "/api/v1/config"
          ? response({ initialized: false })
          : response({ completion: {} });
    }
  });

  const submit = form.listeners.get("submit");
  if (submit === undefined) throw new Error("Expected the preset setup submit handler.");
  const changed = form.listeners.get("input");
  if (changed === undefined) throw new Error("Expected review invalidation when setup details change.");
  if (reviewOptions.changeDuringPreview === true) {
    const submitted = submit({ preventDefault: () => undefined });
    if (resolveDelayedPreview === undefined) throw new Error("Expected a pending preset preview request.");
    await changed();
    const createEnabledAfterChange = create.disabled === false;
    resolveDelayedPreview(response(previewData));
    await submitted;
    const reviewVisibleAfterSubmit = reviewView.hidden === false;
    const createEnabledAfterSubmit = create.disabled === false;
    const reviewText = [reviewSummary.textContent, ...reviewDetails.children.map((item) => item.textContent)];
    const createReviewed = create.listeners.get("click");
    if (createReviewed === undefined) throw new Error("Expected the reviewed-create handler.");
    await createReviewed();
    return {
      requests,
      reviewVisibleAfterSubmit,
      createEnabledAfterSubmit,
      createEnabledAfterChange,
      reviewText
    };
  }
  await submit({ preventDefault: () => undefined });
  const reviewVisibleAfterSubmit = reviewView.hidden === false;
  const createEnabledAfterSubmit = create.disabled === false;
  const reviewText = [reviewSummary.textContent, ...reviewDetails.children.map((item) => item.textContent)];

  if (
    reviewOptions.unsafeReview === true
    || reviewOptions.profileCountMismatch === true
    || (hasProfileCountValue && reviewOptions.profileCountValue !== 1)
  ) {
    return {
      requests,
      reviewVisibleAfterSubmit,
      createEnabledAfterSubmit,
      createEnabledAfterChange: create.disabled === false,
      reviewText,
      statusText: status.textContent
    };
  }

  if (reviewOptions.failFirstCreate === true) {
    await create.click();
    const createEnabledAfterFailure = create.disabled === false;
    await create.click();
    return {
      requests,
      reviewVisibleAfterSubmit,
      createEnabledAfterSubmit,
      createEnabledAfterChange: create.disabled === false,
      createEnabledAfterFailure,
      reviewText
    };
  }

  if (reviewOptions.doubleCreate === true || reviewOptions.editDuringCreate === true || reviewOptions.reReviewDuringCreate === true) {
    const firstCreate = create.click();
    const reviewEditDisabledDuringCreate = edit.disabled;
    if (reviewOptions.editDuringCreate === true) {
      await edit.click();
    }
    if (reviewOptions.reReviewDuringCreate === true) {
      await submit({ preventDefault: () => undefined });
    }
    const secondCreate = create.click();
    if (resolveDelayedCreates.length === 0) throw new Error("Expected a pending reviewed-create request.");
    resolveDelayedCreates.splice(0).forEach((resolve) => resolve(response({ completion: {} })));
    await Promise.all([firstCreate, secondCreate]);
    return {
      requests,
      reviewVisibleAfterSubmit,
      createEnabledAfterSubmit,
      createEnabledAfterChange: create.disabled === false,
      reviewEditDisabledDuringCreate,
      reviewText
    };
  }

  await changed();
  const createEnabledAfterChange = create.disabled === false;

  const createReviewed = create.listeners.get("click");
  if (createReviewed === undefined) throw new Error("Expected the reviewed-create handler.");
  await createReviewed();
  await submit({ preventDefault: () => undefined });
  await createReviewed();

  return {
    requests,
    reviewVisibleAfterSubmit,
    createEnabledAfterSubmit,
    createEnabledAfterChange,
    reviewText
  };
}

function selectConsoleRemoteSetupSource(javascript: string): {
  readonly preset: string;
  readonly updateCalls: number;
  readonly focused: boolean;
  readonly status: string;
} {
  const start = javascript.indexOf("function hideSetupWizardPaths()");
  const end = javascript.indexOf("\n\n  async function refresh", start);
  if (start < 0 || end < 0) throw new Error("Expected the Console setup-source selector.");

  class FakeElement {
    focused = false;
    hidden = false;
    textContent = "";

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
  const presetOnboardingView = new FakeElement();
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
    onboardingView: new FakeElement(),
    presetOnboardingView,
    clientEntryOnboardingView: new FakeElement(),
    setupWizardView: new FakeElement(),
    setupSourceChoice: new FakeElement(),
    setupWizardBack: new FakeElement(),
    setupWizardContinue: new FakeElement(),
    setupWizardStep: new FakeElement(),
    setupWizardCopy: new FakeElement(),
    setupWizardSource: "connector",
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

function exerciseGuidedSetupWizard(javascript: string): {
  readonly chooser: readonly boolean[];
  readonly importPath: readonly boolean[];
  readonly importStep: string;
  readonly back: readonly boolean[];
  readonly cancelled: readonly boolean[];
  readonly resetCounts: readonly number[];
  readonly status: string;
} {
  const start = javascript.indexOf("function hideSetupWizardPaths()");
  const end = javascript.indexOf("\n\n  /** Clears untrusted import text", start);
  if (start < 0 || end < 0) throw new Error("Expected the guided Console setup functions.");

  class FakeElement {
    hidden = false;
    textContent = "";
    focused = false;

    focus(): void {
      this.focused = true;
    }

    scrollIntoView(): void {}

    querySelectorAll(): readonly unknown[] {
      return [];
    }

    replaceChildren(): void {}
  }
  class FakeInput extends FakeElement {}
  class FakeSelect extends FakeElement {
    value = "generic";
  }
  class FakeForm extends FakeElement {
    readonly name = new FakeInput();
    resetCount = 0;

    reset(): void {
      this.resetCount += 1;
    }

    querySelector(selector: string): unknown {
      return selector === "input[name='name']" ? this.name : undefined;
    }
  }

  const onboardingView = new FakeElement();
  const presetOnboardingView = new FakeElement();
  const clientEntryOnboardingView = new FakeElement();
  const setupWizardView = new FakeElement();
  const setupSourceChoice = new FakeElement();
  const setupWizardBack = new FakeElement();
  const setupWizardContinue = new FakeElement();
  const setupWizardStep = new FakeElement();
  const setupWizardTitle = new FakeElement();
  const setupWizardCopy = new FakeElement();
  const setupDraftActions = new FakeElement();
  const workspaceView = new FakeElement();
  const setUpAnotherMcp = new FakeElement();
  const presetForm = new FakeForm();
  const importForm = new FakeForm();
  const oauthForm = new FakeForm();
  const presetSelection = new FakeSelect();
  const accounts = new FakeElement();
  let status = "";

  const functions = runInNewContext(
    `${javascript.slice(start, end)}\n({ showReturningSetup, selectSetupSource, showSetupWizardChooser, cancelSetupWizard })`,
    {
      onboardingView,
      presetOnboardingView,
      clientEntryOnboardingView,
      setupWizardView,
      setupSourceChoice,
      setupWizardBack,
      setupWizardContinue,
      setupWizardStep,
      setupWizardTitle,
      setupWizardCopy,
      setupDraftActions,
      workspaceView,
      setUpAnotherMcp,
      presetOnboardingForm: presetForm,
      clientEntryOnboardingForm: importForm,
      onboardingForm: oauthForm,
      setupWizardSource: "connector",
      returningSetupVisible: false,
      byId(id: string): unknown {
        if (id === "preset-onboarding-form") return presetForm;
        if (id === "client-entry-onboarding-form") return importForm;
        if (id === "onboarding-form") return oauthForm;
        if (id === "preset-selection") return presetSelection;
        if (id === "gsc-account-list") return accounts;
        return undefined;
      },
      updateSetupSourceChoice(): void {},
      updatePresetFields(): void {},
      clearPresetReview(): void {},
      message(value: string): void {
        status = value;
      },
      HTMLElement: FakeElement,
      HTMLFormElement: FakeForm,
      HTMLSelectElement: FakeSelect,
      HTMLInputElement: FakeInput,
      HTMLTextAreaElement: FakeInput,
      HTMLButtonElement: FakeElement
    }
  ) as {
    readonly showReturningSetup: () => void;
    readonly selectSetupSource: (source: string) => void;
    readonly showSetupWizardChooser: (returning: boolean) => void;
    readonly cancelSetupWizard: () => void;
  };

  functions.showReturningSetup();
  const chooser = [
    setupWizardView.hidden,
    setupSourceChoice.hidden,
    onboardingView.hidden,
    presetOnboardingView.hidden,
    clientEntryOnboardingView.hidden,
    setupWizardBack.hidden,
    setupWizardContinue.hidden
  ];
  functions.selectSetupSource("import");
  const importPath = [
    setupSourceChoice.hidden,
    onboardingView.hidden,
    presetOnboardingView.hidden,
    clientEntryOnboardingView.hidden,
    setupWizardBack.hidden,
    setupWizardContinue.hidden
  ];
  const importStep = setupWizardStep.textContent;
  functions.showSetupWizardChooser(true);
  const back = [
    setupSourceChoice.hidden,
    onboardingView.hidden,
    presetOnboardingView.hidden,
    clientEntryOnboardingView.hidden
  ];
  functions.cancelSetupWizard();
  const cancelled = [
    setupWizardView.hidden,
    onboardingView.hidden,
    presetOnboardingView.hidden,
    clientEntryOnboardingView.hidden,
    setUpAnotherMcp.focused
  ];

  return {
    chooser,
    importPath,
    importStep,
    back,
    cancelled,
    resetCounts: [presetForm.resetCount, importForm.resetCount, oauthForm.resetCount],
    status
  };
}

function triggerClientEntryManualRecoveryAction(
  javascript: string,
  id: string,
  source: string
): { readonly selected: readonly string[]; readonly documentCleared: boolean } {
  const start = javascript.indexOf("function bindClientEntryManualRecoveryAction");
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
        return undefined;
      },
      HTMLButtonElement: FakeButton,
      HTMLFormElement: FakeForm,
      HTMLTextAreaElement: FakeTextArea,
      selectSetupSource(value: string): void {
        selected.push(value);
      }
    }
  ) as (targetId: string, targetSource: string, form: unknown) => void;

  bindClientEntryManualRecoveryAction(id, source, form);
  button.listeners.get("click")?.();
  return { selected, documentCleared: documentInput.value === "" };
}

async function resumeMissingSetupDraft(javascript: string): Promise<{
  readonly restored: boolean;
  readonly controlsUpdated: number;
  readonly message: string;
}> {
  const start = javascript.indexOf("if (resumeSetupDraft instanceof HTMLButtonElement)");
  const end = javascript.indexOf("\n\n  if (discardSetupDraft instanceof HTMLButtonElement)", start);
  if (start < 0 || end < 0) throw new Error("Expected the saved setup-draft resume action.");

  class FakeButton {
    readonly listeners = new Map<string, () => void | Promise<void>>();

    addEventListener(name: string, listener: () => void | Promise<void>): void {
      this.listeners.set(name, listener);
    }
  }

  const button = new FakeButton();
  let restored = false;
  let controlsUpdated = 0;
  let status = "";
  runInNewContext(`let activeSetupDraft = { revision: 1 };\n${javascript.slice(start, end)}`, {
    resumeSetupDraft: button,
    HTMLButtonElement: FakeButton,
    api: async () => null,
    restoreSetupDraft(): void {
      restored = true;
      throw new Error("A missing setup draft must not be restored.");
    },
    renderSetupDraftControls(): void {
      controlsUpdated += 1;
    },
    message(value: string): void {
      status = value;
    },
    errorMessage(error: unknown): string {
      return error instanceof Error ? error.message : "unexpected";
    }
  });
  const listener = button.listeners.get("click");
  if (listener === undefined) throw new Error("Expected the saved setup-draft resume listener.");
  await listener();
  return { restored, controlsUpdated, message: status };
}

async function saveSetupDraftOnlyOnce(javascript: string): Promise<{
  readonly requests: number;
  readonly disabledWhilePending: boolean;
  readonly enabledAfterCompletion: boolean;
}> {
  const start = javascript.indexOf("if (saveSetupDraft instanceof HTMLButtonElement)");
  const end = javascript.indexOf("\n\n  if (resumeSetupDraft instanceof HTMLButtonElement)", start);
  if (start < 0 || end < 0) throw new Error("Expected the saved setup-draft save action.");

  type Listener = () => void | Promise<void>;
  class FakeButton {
    disabled = false;
    readonly listeners = new Map<string, Listener>();

    addEventListener(name: string, listener: Listener): void {
      this.listeners.set(name, listener);
    }
  }

  const button = new FakeButton();
  let requests = 0;
  let releaseRequest: () => void = () => undefined;
  const request = new Promise<void>((resolve) => { releaseRequest = resolve; });
  runInNewContext(javascript.slice(start, end), {
    saveSetupDraft: button,
    HTMLButtonElement: FakeButton,
    message(): void {},
    setupDraftIntent(): Record<string, unknown> {
      return { source: "connector", name: "saved-connector", preset: "generic", stage: "connection" };
    },
    api: async () => {
      requests += 1;
      await request;
      return { revision: 1 };
    },
    restoreSetupDraft(): void {},
    errorMessage(): string { return "request failed"; }
  });
  const listener = button.listeners.get("click");
  if (listener === undefined) throw new Error("Expected the saved setup-draft save listener.");
  const first = listener();
  const second = listener();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const disabledWhilePending = button.disabled;
  releaseRequest();
  await Promise.all([first, second]);
  return { requests, disabledWhilePending, enabledAfterCompletion: button.disabled === false };
}

function exerciseSessionResumeLifecycle(javascript: string): {
  readonly callsAfterStartup: number;
  readonly callsAfterNormalPageShow: number;
  readonly callsAfterPersistedPageShow: number;
} {
  const start = javascript.lastIndexOf('if (typeof window !== "undefined")');
  const end = javascript.indexOf("\n})();", start);
  if (start < 0 || end < 0) throw new Error("Expected the Console session-resume startup block.");

  let resumeCalls = 0;
  let pageShow: ((event: { readonly persisted: boolean }) => void) | undefined;
  runInNewContext(javascript.slice(start, end), {
    window: {
      addEventListener(name: string, listener: (event: { readonly persisted: boolean }) => void): void {
        if (name === "pageshow") pageShow = listener;
      }
    },
    resumeSession(): void {
      resumeCalls += 1;
    }
  });
  const callsAfterStartup = resumeCalls;
  pageShow?.({ persisted: false });
  const callsAfterNormalPageShow = resumeCalls;
  pageShow?.({ persisted: true });
  return {
    callsAfterStartup,
    callsAfterNormalPageShow,
    callsAfterPersistedPageShow: resumeCalls
  };
}

function bootstrapResponseErrorMessage(
  javascript: string,
  status: number,
  code: string,
  publicMessage: string,
  retryAfter?: string
): string {
  const start = javascript.indexOf("function bootstrapRecoveryMessage");
  const end = javascript.indexOf("\n\n  async function api", start);
  if (start < 0 || end < 0) throw new Error("Expected the Console bootstrap recovery classifier.");
  const classify = runInNewContext(
    `${javascript.slice(start, end)}\nbootstrapResponseError`,
    {}
  ) as (
    response: { readonly status: number; readonly headers: { get(name: string): string | null } },
    payload: { readonly error: { readonly code: string; readonly message: string } }
  ) => Error;
  return classify(
    {
      status,
      headers: { get: (name) => name === "retry-after" ? retryAfter ?? null : null }
    },
    { error: { code, message: publicMessage } }
  ).message;
}

async function resumeSetupDraftWithoutConnectionValues(javascript: string): Promise<{
  readonly name: string;
  readonly preset: string;
  readonly credential: string;
  readonly resetCount: number;
  readonly accountsCleared: number;
  readonly discardVisible: boolean;
  readonly discardEnabled: boolean;
}> {
  type Listener = () => void | Promise<void>;
  class FakeElement {
    readonly listeners = new Map<string, Listener>();
    textContent = "";

    addEventListener(name: string, listener: Listener): void {
      this.listeners.set(name, listener);
    }

    querySelectorAll(): readonly unknown[] {
      return [];
    }
  }
  class FakeInput extends FakeElement {
    constructor(public value = "") {
      super();
    }
  }
  class FakeSelect extends FakeElement {
    constructor(public value = "generic") {
      super();
    }
  }
  class FakeButton extends FakeElement {
    disabled = false;
    hidden = false;
  }
  const name = new FakeInput("unsafe-name");
  const credential = new FakeInput("UNSAFE_CONNECTION_VALUE");
  const selection = new FakeSelect("generic");
  class FakeForm extends FakeElement {
    resetCount = 0;

    reset(): void {
      this.resetCount += 1;
      name.value = "";
      credential.value = "";
      selection.value = "generic";
    }

    querySelector(selector: string): unknown {
      return selector === "input[name='name']" ? name : undefined;
    }
  }
  class FakeAccountList extends FakeElement {
    cleared = 0;

    replaceChildren(): void {
      this.cleared += 1;
    }
  }

  const form = new FakeForm();
  const accounts = new FakeAccountList();
  const resume = new FakeButton();
  const discard = new FakeButton();
  const status = new FakeElement();
  runInNewContext(javascript, {
    document: {
      getElementById(id: string): unknown {
        if (id === "status") return status;
        if (id === "preset-onboarding-form") return form;
        if (id === "preset-selection") return selection;
        if (id === "gsc-account-list") return accounts;
        if (id === "resume-setup-draft") return resume;
        if (id === "discard-setup-draft") return discard;
        return undefined;
      }
    },
    HTMLFormElement: FakeForm,
    HTMLSelectElement: FakeSelect,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLButtonElement: FakeButton,
    HTMLTextAreaElement: class {},
    Element: FakeElement,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          schemaVersion: 1,
          revision: 2,
          source: "connector",
          name: "saved-connector",
          preset: "generic-npx",
          stage: "connection",
          savedAt: "2026-07-25T12:00:00.000Z"
        }
      })
    })
  });
  const listener = resume.listeners.get("click");
  if (listener === undefined) throw new Error("Expected the saved setup-draft resume listener.");
  await listener();
  return {
    name: name.value,
    preset: selection.value,
    credential: credential.value,
    resetCount: form.resetCount,
    accountsCleared: accounts.cleared,
    discardVisible: discard.hidden === false,
    discardEnabled: discard.disabled === false
  };
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

    setAttribute(name: string, value: string): void {
      void name;
      void value;
    }
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
          : requestPath === "/api/v1/onboarding/preset/preview"
            ? {
                data: {
                  configuration: {
                    sensitiveValues: "omitted",
                    publication: "new-file-only",
                    name: "gsc",
                    defaultProfile: "google-craftmyletter",
                    profileCount: 2,
                    profiles: ["google-craftmyletter", "google-govalidate"],
                    upstreams: [{ name: "default", kind: "local-process", transport: "stdio" }]
                  }
                }
              }
            : { data: {} }
      };
    }
  });

  const submit = form.listeners.get("submit");
  if (submit === undefined) throw new Error("Expected the preset setup submit handler.");
  await submit({ preventDefault: () => undefined });

  const request = requests.find((entry) => entry.path === "/api/v1/onboarding/preset/preview");
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
  it("puts connections and named accounts before collapsed authentication reference", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      const connectionCatalog = html.indexOf('id="configuration-catalog-view"');
      const setupWizard = html.indexOf('id="setup-wizard-view"');
      const authenticationReference = html.indexOf('id="authentication-guide"');

      expect(connectionCatalog).toBeGreaterThan(-1);
      expect(setupWizard).toBeGreaterThan(connectionCatalog);
      expect(authenticationReference).toBeGreaterThan(setupWizard);
      expect(html).toContain("<summary>How authentication works</summary>");
      expect(html).toContain("One connection, named accounts");
      expect(html).toContain("Default for new connections");
      expect(html).toContain("Live account switch");

      const script = await fetch(new URL("/app.js", server.url));
      expect(script.status).toBe(200);
      const javascript = await script.text();
      expect(javascript).toContain("configuration.profileNames");
      expect(javascript).toContain("configuration.profileSwitchingFromMcp");
      expect(javascript).toContain("miftah_use_profile");
    } finally {
      await server.close();
    }
  });

  it("reports MCP connections and hides rejected-file help until the catalog needs attention", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toMatch(/<p id="configuration-catalog-rejected-guidance"[^>]* hidden>/u);

      const script = await fetch(new URL("/app.js", server.url));
      expect(script.status).toBe(200);
      const javascript = await script.text();
      expect(javascript).toContain('catalog.discoveredCount === 1 ? "MCP connection found" : "MCP connections found"');
      expect(javascript).not.toContain("configuration files found");
      expect(javascript).toContain("configurationCatalogRejectedGuidance.hidden = catalog.attentionCount === 0;");
    } finally {
      await server.close();
    }
  });

  it("offers client-specific copyable account-switch requests without claiming Console controls the session", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('id="catalog-client-select"');
      expect(html).toContain('<option value="claude-desktop">Claude Desktop</option>');
      expect(html).toContain('<option value="claude-code">Claude Code</option>');
      expect(html).toContain('<option value="cursor">Cursor</option>');
      expect(html).toContain('<option value="vscode">VS Code</option>');

      const script = await fetch(new URL("/app.js", server.url));
      expect(script.status).toBe(200);
      const javascript = await script.text();
      expect(javascript).toContain("function profileSwitchRequest(client, profile)");
      expect(javascript).toContain("Use the Miftah account named");
      expect(javascript).toContain("Copy switch request");
      expect(javascript).toContain("navigator.clipboard.writeText(profileSwitchRequest(client, profile))");
      expect(javascript).toContain("Console does not switch a running client session.");
      expect(javascript).not.toContain("Live account switch: use miftah_use_profile in your MCP client.");
    } finally {
      await server.close();
    }
  });

  it("groups connection management behind accessible task navigation", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<nav id="workspace-task-navigation" aria-label="Connection tasks">');
      expect(html).toContain('href="#connection-overview">Overview</a>');
      expect(html).toContain('href="#connection-accounts">Accounts</a>');
      expect(html).toContain('href="#connection-authentication">Authentication</a>');
      expect(html).toContain('href="#connection-client-setup">Client setup</a>');
      expect(html).toContain('href="#connection-audit">Audit</a>');
      expect(html).toContain('id="connection-overview"');
      expect(html).toContain('id="connection-accounts"');
      expect(html).toContain('id="connection-authentication"');
      expect(html).toContain('id="connection-client-setup"');
      expect(html).toContain('id="connection-audit"');

      const accounts = html.slice(
        html.indexOf('id="connection-accounts"'),
        html.indexOf('id="connection-authentication"')
      );
      expect(accounts).toContain('id="confirm-profile-removal"');
      expect(accounts).toContain('id="remove-profile"');
    } finally {
      await server.close();
    }
  });

  it("keeps the selected setup form ahead of optional authentication theory", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      const wizard = html.indexOf('id="setup-wizard-view"');
      const connectorForm = html.indexOf('id="preset-onboarding-view"');
      const importForm = html.indexOf('id="client-entry-onboarding-view"');
      const browserSignInForm = html.indexOf('id="onboarding-view"');
      const authenticationReference = html.indexOf('id="authentication-guide"');

      expect(wizard).toBeGreaterThan(-1);
      expect(connectorForm).toBeGreaterThan(wizard);
      expect(importForm).toBeGreaterThan(connectorForm);
      expect(browserSignInForm).toBeGreaterThan(importForm);
      expect(authenticationReference).toBeGreaterThan(browserSignInForm);
      expect(html).toContain("<summary>How authentication works</summary>");
      expect(html).not.toContain('<details id="authentication-guide" class="authentication-guide" open>');
      expect(html).toContain("<label>Connection type");
      expect(html).toContain('<optgroup label="Named presets">');
      expect(html).toContain('<optgroup label="Connection types">');
      expect(html).not.toContain("<label>Known connector");
      expect(html).not.toContain('id="native-oauth-setup-link"');
    } finally {
      await server.close();
    }
  });

  it("finishes setup with a client-specific install, verification, second-account, and switching handoff", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('id="setup-completion-created"');
      expect(html).toContain('id="setup-completion-client-select"');
      expect(html).toContain('id="setup-completion-generate-entry"');
      expect(html).toContain('id="setup-completion-client-target"');
      expect(html).toContain('id="setup-completion-client-json"');
      expect(html).toContain('id="setup-completion-copy-json"');
      expect(html).toContain('id="setup-completion-readiness"');
      expect(html).toContain('id="setup-completion-second-account"');
      expect(html).toContain('id="setup-completion-switch"');

      const script = await fetch(new URL("/app.js", server.url));
      expect(script.status).toBe(200);
      const javascript = await script.text();
      expect(javascript).toContain("function completionFromSetupResult(result");
      expect(javascript).toContain("Created Miftah connection");
      expect(javascript).toContain('/api/v1/client-snippets?client=');
      expect(javascript).toContain("target.label");
      expect(javascript).toContain("restart or reconnect");
      expect(javascript).toContain("Open Manage connection");
      expect(javascript).toContain("copy its switch request");
      expect(javascript).toContain("A generated entry does not prove that a credential works");
      expect(javascript).toContain("async function refreshAfterSetup(completion)");
      expect(javascript.match(/await refreshAfterSetup\(completion\);/gu)).toHaveLength(3);
      expect(javascript).toContain("setupCompletionView.scrollIntoView");
      expect(javascript).toContain("setupCompletionClientSelect.focus");
      expect(javascript).toContain('if (setupCompletionHandoff) setupCompletionHandoff.textContent = "";');
      expect(javascript).toContain("if (client !== selectedSetupCompletionClient()) return;");
    } finally {
      await server.close();
    }
  });

  it("keeps new Console actions keyboard-visible, announced, target-sized, and responsive", async () => {
    const server = await startConsoleServer(await writeConfig(), {
      bootstrapCredential: "test-only-bootstrap-credential"
    });

    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('id="setup-completion-readiness" role="status" aria-live="polite" aria-atomic="true"');
      expect(html).toContain('aria-label="Connection tasks"');

      const stylesheet = await fetch(new URL("/app.css", server.url));
      expect(stylesheet.status).toBe(200);
      const css = await stylesheet.text();
      expect(css).toContain("button:focus-visible, summary:focus-visible");
      expect(css).toContain("#workspace-task-navigation a:focus-visible");
      expect(css).toContain(".configuration-profiles button { min-height: 2.75rem;");
      expect(css).toContain(".setup-completion-copy { grid-template-columns: 1fr;");

      const script = await fetch(new URL("/app.js", server.url));
      expect(script.status).toBe(200);
      const javascript = await script.text();
      expect(javascript).toContain('button.setAttribute("aria-label", "Copy switch request for " + profile + " in " + clientName)');
    } finally {
      await server.close();
    }
  });

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
      expect(html).toContain("Local MCP setup");
      expect(html).not.toContain("Local control plane");
      expect(html).toContain('src="/app.js"');
      expect(html).toContain('href="/app.css"');
      expect(html).toContain('id="snippet-guidance"');
      expect(html).toContain("Remote native OAuth");
      expect(html).toContain("Provider adapter");
      expect(html).toContain("Upstream-owned auth");
      expect(html).toContain("Unsupported state");
      expect(html).toContain("Trust boundary:");
      expect(html).toContain("A reviewed safe check may establish readiness only where declared");
      expect(html).toContain("a configured identity probe is separate");
      expect(html).toContain("not provider-side token scopes or retention");
      expect(html).toContain("One generated entry serves every named account profile in this configuration.");
      expect(html).toContain("A generated entry does not prove that a credential works or belongs to the intended account.");
      expect(html).toContain('id="setup-completion-environment"');
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
      expect(html).toContain('id="save-setup-draft"');
      expect(html).toContain('id="resume-setup-draft"');
      expect(html).toContain('id="discard-setup-draft"');
      expect(html).toContain('id="preset-review-view"');
      expect(html).toContain('id="preset-create-reviewed"');
      expect(html).toContain("Review configuration");
      expect(html).toContain("Create reviewed configuration");
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
      expect(html).toContain('id="profile-rename-editor"');
      expect(html).toContain('id="profile-rename-selection"');
      expect(html).toContain('id="profile-rename-input"');
      expect(html).toContain('id="rename-profile"');
      expect(html).toContain("Rename an account profile");
      expect(html).toContain('id="profile-removal-editor"');
      expect(html).toContain('id="profile-removal-selection"');
      expect(html).toContain('id="profile-removal-replacement"');
      expect(html).toContain('id="confirm-profile-removal"');
      expect(html).toContain('id="remove-profile"');
      expect(html).toContain("Remove an account safely");
      expect(html).toContain('id="profile-inventory-list"');
      expect(html).toContain("Configured accounts");
      expect(html).toContain('id="configuration-catalog-view"');
      expect(html).toContain('id="configuration-catalog-summary"');
      expect(html).toContain('id="configuration-catalog-attention"');
      expect(html).toContain('id="set-up-another-mcp"');
      expect(html).toContain("Set up another MCP");
      expect(html).toContain('id="setup-wizard-view"');
      expect(html).toContain('id="setup-wizard-step"');
      expect(html).toContain('id="setup-wizard-back"');
      expect(html).toContain('id="setup-wizard-cancel"');
      expect(html).toContain('id="setup-wizard-continue"');
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

      const reviewStylesheet = await fetch(new URL("/app.css", server.url));
      expect(reviewStylesheet.status).toBe(200);
      const css = await reviewStylesheet.text();
      expect(css).toContain(".setup-review { padding: 1rem; border: 1px solid var(--key); background: rgb(38 32 20 / 48%); }");
      expect(css).not.toContain("var(--amber)");

      const script = await fetch(new URL("/app.js", server.url));
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      const javascript = await script.text();
      expect(javascript).toContain("/api/v1/sessions");
      expect(javascript).toContain("/api/v1/session");
      expect(javascript).toContain("async function resumeSession()");
      expect(javascript).toContain("void resumeSession();");
      expect(javascript).toContain("Run `miftah dashboard` in the terminal");
      expect(exerciseSessionResumeLifecycle(javascript)).toEqual({
        callsAfterStartup: 1,
        callsAfterNormalPageShow: 1,
        callsAfterPersistedPageShow: 2
      });
      expect(bootstrapResponseErrorMessage(
        javascript,
        429,
        "rate_limit_exceeded",
        "The local Console request limit was reached.",
        "42"
      )).toBe("Too many unlock attempts. Wait 42 seconds before trying again; keep this Console process running.");
      expect(bootstrapResponseErrorMessage(
        javascript,
        503,
        "service_unavailable",
        "The Console is shutting down."
      )).toBe("The Console is shutting down.");
      expect(javascript).toContain("/api/v1/onboarding/native-oauth/discover");
      expect(javascript).toContain("showReturningSetup");
      expect(javascript).toContain("showSetupWizardChooser");
      expect(javascript).toContain("hideSetupWizardPaths");
      expect(javascript).toContain("cancelSetupWizard");
      const returningSetupBody = javascript.slice(
        javascript.indexOf("function showReturningSetup()"),
        javascript.indexOf("\n\n  /** Clears untrusted import text", javascript.indexOf("function showReturningSetup()"))
      );
      expect(returningSetupBody).toContain("showSetupWizardChooser");
      expect(returningSetupBody).not.toContain("onboardingView.hidden = false");
      expect(returningSetupBody).not.toContain("presetOnboardingView.hidden = false");
      expect(returningSetupBody).not.toContain("clientEntryOnboardingView.hidden = false");
      expect(exerciseGuidedSetupWizard(javascript)).toEqual({
        chooser: [false, false, true, true, true, true, false],
        importPath: [true, true, true, false, false, true],
        importStep: "Step 2 of 3 · Existing client entry",
        back: [false, true, true, true],
        cancelled: [true, true, true, true, true],
        resetCounts: [1, 1, 1],
        status: "Setup cancelled. No configuration was created or changed."
      });
      const attentionBranch = javascript.slice(
        javascript.indexOf("if (catalog.attentionCount > 0)"),
        javascript.indexOf('if (catalog.discoveryState === "unavailable")')
      );
      expect(attentionBranch).toContain("hideSetupWizardPaths()");
      expect(attentionBranch).toContain("returningSetupVisible = false");
      const discoveryUnavailableBranch = javascript.slice(
        javascript.indexOf('if (catalog.discoveryState === "unavailable")'),
        javascript.indexOf('setupWizardSource = "connector"', javascript.indexOf('if (catalog.discoveryState === "unavailable")'))
      );
      expect(discoveryUnavailableBranch).toContain("hideSetupWizardPaths()");
      expect(discoveryUnavailableBranch).toContain("returningSetupVisible = false");
      expect(javascript).toContain("Choose a short lowercase name");
      expect(javascript).toContain("/api/v1/connections/discover");
      expect(javascript).toContain("/api/v1/profiles/native-oauth/discover");
      expect(javascript).toContain("/api/v1/profiles/provider-account");
      expect(javascript).toContain("/api/v1/profiles/environment-account");
      expect(javascript).toContain("/api/v1/onboarding/preset/preview");
      expect(javascript).toContain("/api/v1/onboarding/preset");
      expect(javascript).toContain("/api/v1/setup-draft");
      expect(javascript).toContain("function restoreSetupDraft");
      expect(javascript).not.toContain("localStorage");
      expect(javascript).not.toContain("sessionStorage");
      await expect(resumeMissingSetupDraft(javascript)).resolves.toEqual({
        restored: false,
        controlsUpdated: 1,
        message: "No saved connector choice exists. Start with a configuration name and connector above."
      });
      await expect(resumeSetupDraftWithoutConnectionValues(javascript)).resolves.toEqual({
        name: "saved-connector",
        preset: "generic-npx",
        credential: "",
        resetCount: 1,
        accountsCleared: 1,
        discardVisible: true,
        discardEnabled: true
      });
      await expect(saveSetupDraftOnlyOnce(javascript)).resolves.toEqual({
        requests: 1,
        disabledWhilePending: true,
        enabledAfterCompletion: true
      });
      expect(javascript).toContain("if (resumeSetupDraft.disabled) return;");
      expect(javascript).toContain("resumeSetupDraft.disabled = true;");
      expect(javascript).toContain("finally { resumeSetupDraft.disabled = false; }");
      expect(javascript).toContain("if (activeSetupDraft === undefined || discardSetupDraft.disabled) return;");
      expect(javascript).toContain("discardSetupDraft.disabled = true;");
      expect(javascript).toContain("finally { discardSetupDraft.disabled = false; }");
      expect(javascript).toContain("renderSetupCompletion");
      expect(javascript).toContain("completion.environment");
      expect(javascript).toContain("setupCompletionEnvironment");
      expect(javascript).toContain("function clearSetupCompletion()");
      const refreshBody = javascript.slice(
        javascript.indexOf("async function refresh()"),
        javascript.indexOf("if (unlockForm instanceof HTMLFormElement")
      );
      expect(refreshBody.indexOf("clearSetupCompletion();")).toBeLessThan(
        refreshBody.indexOf('api("/api/v1/config")')
      );
      const completionAssignments = [...javascript.matchAll(/setupCompletion = completion;/gu)];
      expect(completionAssignments).toHaveLength(1);
      const refreshAfterSetup = javascript.slice(
        javascript.indexOf("async function refreshAfterSetup(completion)"),
        javascript.indexOf("function clearSetupCompletion()")
      );
      expect(refreshAfterSetup.indexOf("await refresh();")).toBeLessThan(
        refreshAfterSetup.indexOf("setupCompletion = completion;")
      );
      expect(refreshAfterSetup).toContain("finally");
      expect(javascript).toContain("MCP connections found");
      expect(javascript).toContain("need attention");
      expect(javascript).toContain('"file-permissions": "private file permission"');
      expect(javascript).not.toContain('"file-permissions": "private file permissions"');
      expect(javascript).toContain("invalid configuration");
      expect(javascript).toContain("unsafe path or file replacement");
      expect(javascript).toContain("function selectSetupSource(source)");
      expect(javascript).toContain("setup-source-choice");
      expect(javascript).toContain('querySelectorAll("input[data-setup-source]")');
      expect(javascript).toContain('setupSourceChoice.addEventListener("change"');
      expect(javascript).toContain("local-stdio");
      expect(javascript).toContain("acceptLocalCommand");
      expect(javascript).toContain("/api/v1/onboarding/client-entry");
      expect(javascript).toContain('bindClientEntryManualRecoveryAction("client-entry-manual-local", "local", clientEntryOnboardingForm)');
      expect(javascript).toContain('bindClientEntryManualRecoveryAction("client-entry-manual-remote", "remote", clientEntryOnboardingForm)');
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
      const reviewedPreset = await reviewThenCreatePresetForm(javascript);
      expect(reviewedPreset).toMatchObject({
        reviewVisibleAfterSubmit: true,
        createEnabledAfterSubmit: true,
        createEnabledAfterChange: false
      });
      expect(reviewedPreset.reviewText.join(" ")).toContain("Miftah will create 'analytics' with 1 account profile(s).");
      expect(reviewedPreset.reviewText.join(" ")).toContain("Publication: a new configuration file only");
      expect(reviewedPreset.reviewText.join(" ")).not.toContain("ANALYTICS_TOKEN");
      expect(reviewedPreset.requests.map((request) => request.path)).toEqual([
        "/api/v1/onboarding/preset/preview",
        "/api/v1/onboarding/preset/preview",
        "/api/v1/onboarding/preset",
        "/api/v1/config"
      ]);
      expect(reviewedPreset.requests[0]?.body).toBe(reviewedPreset.requests[2]?.body);
      const stalePreview = await reviewThenCreatePresetForm(javascript, { changeDuringPreview: true });
      expect(stalePreview).toMatchObject({
        reviewVisibleAfterSubmit: false,
        createEnabledAfterSubmit: false,
        createEnabledAfterChange: false,
        reviewText: [""]
      });
      expect(stalePreview.requests.map((request) => request.path)).toEqual([
        "/api/v1/onboarding/preset/preview"
      ]);
      const duplicateCreate = await reviewThenCreatePresetForm(javascript, { doubleCreate: true });
      expect(duplicateCreate.requests.filter((request) => request.path === "/api/v1/onboarding/preset")).toHaveLength(1);
      const reReviewedCreate = await reviewThenCreatePresetForm(javascript, { reReviewDuringCreate: true });
      expect(reReviewedCreate.requests.filter((request) => request.path === "/api/v1/onboarding/preset")).toHaveLength(1);
      expect(reReviewedCreate.requests.filter((request) => request.path === "/api/v1/onboarding/preset/preview")).toHaveLength(1);
      const editDuringCreate = await reviewThenCreatePresetForm(javascript, { editDuringCreate: true });
      expect(editDuringCreate.reviewEditDisabledDuringCreate).toBe(true);
      expect(editDuringCreate.requests.filter((request) => request.path === "/api/v1/onboarding/preset")).toHaveLength(1);
      const failedThenRetriedCreate = await reviewThenCreatePresetForm(javascript, { failFirstCreate: true });
      expect(failedThenRetriedCreate.createEnabledAfterFailure).toBe(true);
      expect(failedThenRetriedCreate.requests.filter((request) => request.path === "/api/v1/onboarding/preset")).toHaveLength(2);
      const unsafeReview = await reviewThenCreatePresetForm(javascript, { unsafeReview: true });
      expect(unsafeReview).toMatchObject({
        reviewVisibleAfterSubmit: false,
        createEnabledAfterSubmit: false,
        statusText: "Miftah did not return a safe configuration review."
      });
      expect(unsafeReview.requests.map((request) => request.path)).toEqual(["/api/v1/onboarding/preset/preview"]);
      const inconsistentProfileCount = await reviewThenCreatePresetForm(javascript, { profileCountMismatch: true });
      expect(inconsistentProfileCount).toMatchObject({
        reviewVisibleAfterSubmit: false,
        createEnabledAfterSubmit: false,
        statusText: "Miftah did not return a safe configuration review."
      });
      expect(inconsistentProfileCount.requests.map((request) => request.path)).toEqual(["/api/v1/onboarding/preset/preview"]);
      const malformedProfileCount = await reviewThenCreatePresetForm(javascript, { profileCountValue: "1" });
      expect(malformedProfileCount).toMatchObject({
        reviewVisibleAfterSubmit: false,
        createEnabledAfterSubmit: false,
        statusText: "Miftah did not return a safe configuration review."
      });
      expect(malformedProfileCount.requests.map((request) => request.path)).toEqual(["/api/v1/onboarding/preset/preview"]);
      const nullProfileCount = await reviewThenCreatePresetForm(javascript, { profileCountValue: null });
      expect(nullProfileCount).toMatchObject({
        reviewVisibleAfterSubmit: false,
        createEnabledAfterSubmit: false,
        statusText: "Miftah did not return a safe configuration review."
      });
      expect(nullProfileCount.requests.map((request) => request.path)).toEqual(["/api/v1/onboarding/preset/preview"]);
      const matchingProfileCount = await reviewThenCreatePresetForm(javascript, { profileCountValue: 1 });
      expect(matchingProfileCount).toMatchObject({
        reviewVisibleAfterSubmit: true,
        createEnabledAfterSubmit: true
      });
      const omittedProfileCount = await reviewThenCreatePresetForm(javascript, { omitProfileCount: true });
      expect(omittedProfileCount).toMatchObject({
        reviewVisibleAfterSubmit: true,
        createEnabledAfterSubmit: true
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
      expect(javascript).toContain('byId("snippet-guidance")');
      expect(javascript).toContain('guidance.textContent = typeof first.guidance === "string" ? first.guidance : ""');
      expect(javascript).toContain("/api/v1/configurations/");
      expect(javascript).toContain("/api/v1/profile-readiness");
      expect(javascript).toContain("/api/v1/profiles/default");
      expect(javascript).toContain('body: { profile: profile.value }');
      expect(javascript).toContain("/api/v1/profiles/description");
      expect(javascript).toContain("renderProfileDescriptionEditor");
      expect(javascript).toContain("/api/v1/profiles/rename");
      expect(javascript).toContain("renderProfileRenameEditor");
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

  it("serves a CSRF-protected first-run connector draft without accepting connection data", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-draft-http-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root);
    const directory = join(privateParent, "miftah");
    const configPath = join(directory, "miftah.json");
    const draftStore = new FileSetupDraftStore({ directory: join(privateParent, "setup-draft") });
    const server = await startConsoleServer(configPath, {
      bootstrapCredential: "test-only-bootstrap-credential",
      allowMissingConfig: true,
      deferConfigValidation: true,
      application: new ConsoleDashboardApplicationService({
        defaultConfigPath: configPath,
        configDirectory: directory,
        launcher: { command: process.execPath, args: [join(process.cwd(), "dist", "cli", "main.js"), "serve"] },
        setupDraftStore: draftStore
      })
    });

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/setup-draft", server.url);
      const unauthorized = await fetch(endpoint, { headers: { origin: server.url.origin } });
      expect(unauthorized.status).toBe(401);

      const missingCsrf = await fetch(endpoint, {
        method: "PUT",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          source: "connector",
          name: "support-tools",
          preset: "generic",
          stage: "connection"
        })
      });
      expect(missingCsrf.status).toBe(403);

      const unsafe = await fetch(endpoint, {
        method: "PUT",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          source: "connector",
          name: "support-tools",
          preset: "generic",
          stage: "connection",
          credentialEnv: "SUPPORT_TOKEN"
        })
      });
      expect(unsafe.status).toBe(422);

      const saved = await fetch(endpoint, {
        method: "PUT",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          source: "connector",
          name: "support-tools",
          preset: "generic",
          stage: "connection",
          expectedRevision: 0
        })
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        data: {
          schemaVersion: 1,
          revision: 1,
          source: "connector",
          name: "support-tools",
          preset: "generic",
          stage: "connection"
        }
      });

      const loaded = await fetch(endpoint, {
        headers: { origin: server.url.origin, cookie: session.cookie }
      });
      expect(loaded.status).toBe(200);
      const loadedText = await loaded.text();
      expect(loadedText).toContain("support-tools");
      expect(loadedText).not.toContain("SUPPORT_TOKEN");

      const deleted = await fetch(endpoint, {
        method: "DELETE",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ revision: 1 })
      });
      expect(deleted.status).toBe(204);
      await expect(draftStore.load()).resolves.toBeUndefined();
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

        const preview = await fetch(new URL("/api/v1/onboarding/preset/preview", server.url), {
          method: "POST",
          headers: {
            origin: server.url.origin,
            cookie: session.cookie,
            "x-miftah-csrf": session.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify(request)
        });
        expect(preview.status).toBe(200);
        const previewBody = await preview.json();
        expect(previewBody).toMatchObject({
          data: {
            changed: false,
            write: false,
            name: "support-tools",
            defaultProfile: "default",
            configuration: {
              sensitiveValues: "omitted",
              publication: "new-file-only"
            }
          }
        });
        expect(JSON.stringify(previewBody)).not.toContain("SUPPORT_TOKEN");
        expect(JSON.stringify(previewBody)).not.toContain(configPath);
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
              environment: {
                state: "missing",
                requiredVariables: ["SUPPORT_TOKEN"],
                missingVariables: ["SUPPORT_TOKEN"],
                message: "Missing from this setup process: SUPPORT_TOKEN.",
                nextAction:
                  "Set SUPPORT_TOKEN in the environment inherited by the Miftah process your MCP client launches. The generated client JSON does not set or contain the secret."
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

    it("shows Sentry environment readiness in Console and client handoff without exposing the secret", async () => {
      vi.stubEnv("SENTRY_ACCESS_TOKEN", "provider-secret-value");
      const request = process.platform === "win32"
        ? {
            name: "sentry",
            preset: "generic-docker",
            dockerImage:
              "ghcr.io/acme/sentry-mcp@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            credentialEnv: "SENTRY_ACCESS_TOKEN"
          }
        : { name: "sentry", preset: "sentry" };
      const server = await startConsoleServer(configPath, {
        bootstrapCredential: "test-only-bootstrap-credential",
        allowMissingConfig: true,
        launcher: { command: process.execPath, args: [join(process.cwd(), "dist", "cli", "main.js"), "serve"] }
      });

      try {
        const session = await bootstrapSession(server);
        const created = await fetch(new URL("/api/v1/onboarding/preset", server.url), {
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
          data: {
            completion: {
              verification: { state: "not-declared" },
              environment: {
                state: "available",
                requiredVariables: ["SENTRY_ACCESS_TOKEN"],
                missingVariables: [],
                message: "Available to this setup process: SENTRY_ACCESS_TOKEN.",
                nextAction:
                  "Make sure your MCP client passes SENTRY_ACCESS_TOKEN to the Miftah process it launches. This does not verify the credential or provider."
              }
            }
          }
        });
        expect(JSON.stringify(createdBody)).not.toContain("provider-secret-value");

        const snippets = await fetch(new URL("/api/v1/client-snippets?client=claude-desktop", server.url), {
          headers: { origin: server.url.origin, cookie: session.cookie }
        });
        expect(snippets.status).toBe(200);
        const snippetBody = await snippets.json() as {
          data: Array<{ guidance: string; json: string }>;
        };
        expect(snippetBody.data[0]?.guidance).toContain(
          "Before restarting Claude Desktop, make sure it passes SENTRY_ACCESS_TOKEN to the Miftah process it launches."
        );
        expect(snippetBody.data[0]?.json).not.toContain("SENTRY_ACCESS_TOKEN");
        expect(JSON.stringify(snippetBody)).not.toContain("provider-secret-value");
        expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
          profiles: { default: { env: { SENTRY_ACCESS_TOKEN: "${SENTRY_ACCESS_TOKEN}" } } }
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
              environment: {
                state: "missing",
                requiredVariables: ["LOCAL_MCP_TOKEN"],
                missingVariables: ["LOCAL_MCP_TOKEN"],
                message: "Missing from this setup process: LOCAL_MCP_TOKEN.",
                nextAction:
                  "Set LOCAL_MCP_TOKEN in the environment inherited by the Miftah process your MCP client launches. The generated client JSON does not set or contain the secret."
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
              environment: {
                state: "not-required",
                requiredVariables: [],
                missingVariables: [],
                message: "This configuration does not require an environment-backed secret."
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
              environment: {
                state: "not-required",
                requiredVariables: [],
                missingVariables: [],
                message: "This configuration does not require an environment-backed secret."
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
      profiles: { work: {}, personal: {} },
      security: { allowProfileSwitchingFromMcp: true }
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
        data: {
          initialized: boolean;
          catalog?: {
            configurations: Array<{
              id: string;
              name: string;
              profileNames: string[];
              profileSwitchingFromMcp: boolean;
            }>;
          };
        };
      };
      expect(initialBody.data.initialized).toBe(false);
      expect(initialBody.data.catalog?.configurations).toHaveLength(1);
      expect(initialBody.data.catalog?.configurations[0]).toMatchObject({
        name: "gsc",
        profileNames: ["personal", "work"],
        profileSwitchingFromMcp: true
      });
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

  it("creates another safe configuration through the returning-user dashboard API", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-console-returning-setup-"));
    temporaryDirectories.push(root);
    const privateParent = await createPrivateConsoleDirectory(root, "private-parent");
    const directory = await createPrivateConsoleDirectory(privateParent);
    await writePrivateConsoleFile(join(directory, "gsc.json"), `${JSON.stringify({
      version: "3",
      name: "gsc",
      defaultProfile: "work",
      upstream: { transport: "stdio", command: "uvx", args: ["mcp-search-console@0.3.2"] },
      profiles: { work: {} }
    })}\n`);
    const server = await startConsoleServer(join(directory, "miftah.json"), {
      bootstrapCredential: "test-only-bootstrap-credential",
      allowMissingConfig: true,
      deferConfigValidation: true,
      application: new ConsoleDashboardApplicationService({
        defaultConfigPath: join(directory, "miftah.json"),
        configDirectory: directory
      })
    });

    try {
      const session = await bootstrapSession(server);
      const endpoint = new URL("/api/v1/onboarding/preset", server.url);
      const headers = {
        origin: server.url.origin,
        cookie: session.cookie,
        "x-miftah-csrf": session.csrfToken,
        "content-type": "application/json"
      };
      const unsafe = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "../escape", ...supportedKnownConnectorOptions() })
      });
      expect(unsafe.status).toBe(422);
      expect(await unsafe.json()).toEqual({
        error: {
          code: "configuration_target_invalid",
          message: "Choose a short lowercase configuration name using letters, numbers, dots, underscores, or hyphens."
        }
      });
      await expect(readFile(join(root, "escape.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });

      const created = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "support-tools", ...supportedKnownConnectorOptions() })
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        data: { name: "support-tools", write: true }
      });
      await expect(readFile(join(directory, "support-tools.json"), "utf8"))
        .resolves.toContain('"name": "support-tools"');
      await expect(readFile(join(directory, "miftah.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
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
      expect(await unauthenticated.json()).toEqual({
        error: {
          code: "session_missing",
          message: "Enter the one-time Console code from this process."
        }
      });

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
      expect(await mcpBearer.json()).toEqual({
        error: {
          code: "bootstrap_malformed",
          message: "Enter the complete one-time Console code from this process."
        }
      });

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

      const resumedSession = await fetch(new URL("/api/v1/session", server.url), {
        headers: { cookie: cookie!.split(";", 1)[0]! }
      });
      expect(resumedSession.status).toBe(200);
      const resumedSessionBody = await resumedSession.json() as {
        readonly data: { readonly csrfToken: string; readonly expiresInMs: number };
      };
      expect(resumedSessionBody.data.csrfToken).toBe(bootstrapBody.data.csrfToken);
      expect(resumedSessionBody.data.expiresInMs).toBeGreaterThan(0);
      expect(resumedSessionBody.data.expiresInMs).toBeLessThanOrEqual(60 * 60_000);

      const secondTabSession = await fetch(new URL("/api/v1/session", server.url), {
        headers: { cookie: cookie!.split(";", 1)[0]! }
      });
      expect(secondTabSession.status).toBe(200);
      expect(await secondTabSession.json()).toMatchObject({
        data: { csrfToken: bootstrapBody.data.csrfToken }
      });

      const hostileResume = await fetch(new URL("/api/v1/session", server.url), {
        headers: {
          origin: "https://attacker.example.test",
          cookie: cookie!.split(";", 1)[0]!
        }
      });
      expect(hostileResume.status).toBe(403);

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

  it("renames a profile only through a strict CSRF-protected Console request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-profile-rename-"));
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
      const endpoint = new URL("/api/v1/profiles/rename", server.url);
      const rejected = await fetch(endpoint, {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "work", newProfile: "studio", credential: "never-accepted" })
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
        body: JSON.stringify({ profile: "work", newProfile: "studio" })
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({
        data: {
          changed: true,
          write: true,
          profile: "work",
          newProfile: "studio",
          actions: ["Renamed profile 'work' to 'studio'."]
        }
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultProfile: "studio",
        profiles: {
          studio: { env: { API_KEY: "${WORK_API_KEY}" } },
          personal: { env: { API_KEY: "${PERSONAL_API_KEY}" } }
        }
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

  it("renames a configured native OAuth binding through the same strict Console request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-console-profile-rename-oauth-"));
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
    const oauth = createMemoryProfileRenameOAuthDependencies();
    const server = await startConsoleServer(configPath, {
      bootstrapCredential: "test-only-bootstrap-credential",
      application: new ConsoleApplicationService(configPath, { oauthProfileRename: oauth.dependencies })
    });

    try {
      const session = await bootstrapSession(server);
      const response = await fetch(new URL("/api/v1/profiles/rename", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "work", newProfile: "studio" })
      });
      const responseBody = await response.json();
      expect(response.status, JSON.stringify(responseBody)).toBe(200);
      expect(responseBody).toEqual({
        data: {
          changed: true,
          write: true,
          profile: "work",
          newProfile: "studio",
          actions: ["Renamed profile 'work' to 'studio'."]
        }
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        defaultProfile: "studio",
        profiles: { studio: {}, personal: {} },
        oauth: {
          connections: {
            "oauthconn:11111111-1111-4111-8111-111111111111": { profile: "studio" }
          }
        }
      });
    } finally {
      await server.close();
    }
  });

  it("requires configuration reload after a completed native OAuth rename recovery", async () => {
    const configPath = await writeConfig();
    const application = {
      async renameProfile() {
        throw new MiftahError(
          "PROFILE_SELECTION_STALE",
          "PROFILE_SELECTION_STALE: OAuth profile-rename recovery completed; reload configuration before retrying"
        );
      }
    } as unknown as ConsoleControlApplication;
    const server = await startConsoleServer(configPath, {
      bootstrapCredential: "test-only-bootstrap-credential",
      application
    });

    try {
      const session = await bootstrapSession(server);
      const response = await fetch(new URL("/api/v1/profiles/rename", server.url), {
        method: "POST",
        headers: {
          origin: server.url.origin,
          cookie: session.cookie,
          "x-miftah-csrf": session.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ profile: "work", newProfile: "studio" })
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "profile_selection_stale",
          message: "The configuration changed during recovery; reload it before retrying."
        }
      });
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
    expect(await staleBootstrap.json()).toEqual({
      error: {
        code: "bootstrap_expired",
        message: "This one-time Console code expired."
      }
    });

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
    expect(await replay.json()).toEqual({
      error: {
        code: "bootstrap_used",
        message: "This one-time Console code was already used."
      }
    });

    now += 101;
    const expired = await fetch(new URL("/api/v1/health", server.url), {
      headers: { origin: server.url.origin, cookie: session.cookie }
    });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({
      error: {
        code: "session_expired",
        message: "This Console session expired."
      }
    });

    const replacement = server.rotateCredential();
    expect(replacement).not.toBe(activeBootstrap);
    const invalidatedSession = await fetch(new URL("/api/v1/session", server.url), {
      headers: { cookie: session.cookie }
    });
    expect(invalidatedSession.status).toBe(401);
    expect(await invalidatedSession.json()).toEqual({
      error: {
        code: "session_unavailable",
        message: "This Console session belongs to an earlier or different process."
      }
    });
    const superseded = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: `Bootstrap ${activeBootstrap}`,
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(superseded.status).toBe(401);
    expect(await superseded.json()).toEqual({
      error: {
        code: "bootstrap_superseded",
        message: "This one-time Console code was replaced by a newer code."
      }
    });
    const wrongProcess = await fetch(firstUrl, {
      method: "POST",
      headers: {
        origin: server.url.origin,
        authorization: "Bootstrap wrong-process-bootstrap-credential",
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(wrongProcess.status).toBe(401);
    expect(await wrongProcess.json()).toEqual({
      error: {
        code: "bootstrap_wrong_process",
        message: "This code does not belong to the running Console process."
      }
    });
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
