#!/usr/bin/env node
/**
 * Pre-install check of the plugin: the settings schema, the tool inventory and
 * compilation of all schemas (parameters and output) with the same compiler the
 * harness uses.
 *
 * Run from the plugin directory:
 *   node tools/check-plugin.mjs
 *
 * A dev-time script: the plugin itself imports nothing from @deepseek-ai except
 * the settings schema, so the compiler is loaded here by the absolute path of the
 * installed dsh.
 */
import fs from 'node:fs';
import process from 'node:process';

/**
 * Where the harness packages live. Run from inside a profile, the bare import below
 * resolves through the profile module tree; DSH_PACKAGES covers a bare checkout.
 */
const DSH_PACKAGES =
  process.env.DSH_PACKAGES ?? '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

async function loadCompiler() {
  try {
    return await import('@deepseek-ai/dsh-tools');
  } catch {
    // Not resolvable from here — fall through to the installation path.
  }
  const entry = `${DSH_PACKAGES}/dsh-tools/lib/index.js`;
  try {
    return await import(entry);
  } catch (error) {
    throw new Error(
      'cannot load @deepseek-ai/dsh-tools: install this plugin into a dsh profile, or point ' +
        `DSH_PACKAGES at the harness package directory (tried ${entry}) — ${error?.message ?? error}`,
    );
  }
}

/** A live reference to a value, as the settings service hands it out. */
function live(value) {
  return { get: () => value };
}

const problems = [];
const note = (message) => problems.push(message);

const { assertSupportedJsonSchema, defineTool } = await loadCompiler();
const plugin = await import('../index.js');

if (!plugin.Config) note('index.js does not export Config — the settings form will not build');
if (!Array.isArray(plugin.inject) || plugin.inject.length === 0) note('index.js does not export inject');
if (typeof plugin.apply !== 'function') note('index.js does not export apply');

const registered = [];
const configValues = {
  sshHost: 'proxmox',
  sshUser: 'root',
  sshPort: 22,
  sshKeyPath: '',
  sshConfigFile: '',
  sshExtraOptions: [],
  allowVmids: [4242],
  enableConsole: true,
  enableGuest: true,
  inputChannel: 'auto',
  sendkeyDelayMs: 80,
  consoleTimeoutMs: 20000,
  sessionIdleMs: 300000,
  guestTimeoutMs: 60000,
  guestTypeCommand: 'echo {base64}',
  viewAutoOpen: false,
  viewFollowAgent: true,
  viewFps: 2,
  viewScale: 2,
};
const liveConfig = Object.fromEntries(Object.entries(configValues).map(([key, value]) => [key, live(value)]));

const ctx = {
  tools: { register: (definition) => registered.push(definition) },
  attachments: { saveImage: async () => ({ attachmentId: 'x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }) },
  subprocess: { spawn: () => ({ stdin: null, stdout: null, stderr: null, done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true }) },
  effect: (fn) => {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  inject: () => {},
};

try {
  plugin.apply(ctx, liveConfig);
} catch (error) {
  note(`apply threw: ${error?.stack ?? error}`);
}

if (registered.length === 0) note('apply registered no tools');

const seen = new Set();
for (const definition of registered) {
  const name = definition?.name ?? '<unnamed>';
  if (seen.has(name)) note(`tool ${name} is registered twice`);
  seen.add(name);
  if (typeof definition.description !== 'string' || definition.description.length < 20) note(`${name}: description is too short`);
  if (typeof definition.execute !== 'function') note(`${name}: no execute`);
  if (typeof definition.output?.render !== 'function') note(`${name}: no output.render`);
  if (definition.output?.schema === undefined) note(`${name}: no output.schema`);
  // Tools arrive already wrapped in defineTool: the schemas are compiled, and the
  // registry validates them as raw JSON Schema — repeat that check here, or the
  // error only surfaces when the plugin is installed into a profile (it did).
  try {
    assertSupportedJsonSchema(definition.parameters ?? {});
  } catch (error) {
    note(`${name}: the registry will reject the parameters schema — ${error.message}`);
  }
  try {
    assertSupportedJsonSchema(definition.output.schema);
  } catch (error) {
    note(`${name}: the registry will reject the output schema — ${error.message}`);
  }
  // defineTool does not expose validate — it wraps execute itself, so the mark of
  // that wrapping here is a compiled (raw) parameters schema.
  if (definition.parameters?.type !== 'object') note(`${name}: parameters schema not compiled — definition did not pass defineTool`);
}

// Pure layout functions: a quick contract test.
const { encodeText, parseCombo } = await import('../lib/keys.js');
try {
  const steps = encodeText('Hello, World!\n');
  if (steps.length !== 'Hello, World!\n'.length) note(`encodeText: expected ${'Hello, World!\n'.length} steps, got ${steps.length}`);
  if (!steps.some((step) => step.shift)) note('encodeText: did not set shift for capitals and symbols');
  let threw = false;
  try {
    encodeText('привет');
  } catch {
    threw = true;
  }
  if (!threw) note('encodeText: Cyrillic must throw a clear error');
  const combo = parseCombo('ctrl+alt+del');
  if (combo.modifiers.length !== 2 || combo.key !== 0xffff) note('parseCombo: ctrl+alt+del parsed incorrectly');
} catch (error) {
  note(`layout check threw: ${error.message}`);
}

// The settings schema must build and contain every key.
try {
  const { Config, CONFIG_KEYS, resolveSettings, snapshot } = await import('../lib/config.js');
  const resolved = Config(configValues);
  for (const key of CONFIG_KEYS) {
    if (!(key in configValues)) note(`CONFIG_KEYS contains ${key}, which is not among the test values`);
  }
  const settings = resolveSettings(snapshot(liveConfig));
  if (!Array.isArray(settings.allowVmids) || settings.allowVmids[0] !== 4242) note('resolveSettings: allowVmids parsed incorrectly');
  if (typeof settings.guestTypeCommand !== 'string') note('resolveSettings: guestTypeCommand is not a string');
  // The input-channel keys must reach the tools from the form: without them the
  // setting is silently ignored (inputChannel/sendkeyDelayMs were lost that way once).
  if (settings.inputChannel !== 'auto') note(`resolveSettings: inputChannel = ${settings.inputChannel}, expected auto`);
  if (settings.sendkeyDelayMs !== 80) note(`resolveSettings: sendkeyDelayMs = ${settings.sendkeyDelayMs}, expected 80`);
  // The observation panel values from the same form, plus their bounds.
  if (settings.view.fps !== 2 || settings.view.scale !== 2) note('resolveSettings: panel pace and divisor are not 2 by default');
  if (settings.view.autoOpen !== false) note('resolveSettings: panel auto-open must be off by default');
  if (settings.view.followAgent !== true) note('resolveSettings: following the agent is on by default');
  const wild = resolveSettings({ viewFps: 99, viewScale: 0 });
  if (wild.view.fps !== 4 || wild.view.scale !== 1) note(`resolveSettings: panel bounds are not honoured (${wild.view.fps}/${wild.view.scale})`);
  // The settings service hands `.volatile()` fields out as live references even on a direct schema call.
  if (resolved.sshHost?.get?.() !== 'proxmox') note('Config: sshHost was not applied');
} catch (error) {
  note(`settings check threw: ${error.stack ?? error}`);
}

// Panel routes: the inventory, the fence and the state answer. Frames need a live
// VM, so only what is decided without a node is checked here.
try {
  const { registerViewRoutes, VIEW_BASE } = await import('../lib/routes.js');
  const routes = [];
  let disposers = 0;
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {
        disposers += 1;
      };
    },
  };
  const state = {
    allowed: [4242],
    consoleEnabled: true,
    sessions: [],
    last: null,
    view: { autoOpen: false, followAgent: true, fps: 2, scale: 2 },
  };
  const dispose = registerViewRoutes(webServer, {
    view: { state: () => state, frame: async () => ({ png: Buffer.alloc(0), meta: {} }), release: () => true },
  });
  const paths = routes.map((route) => route.path);
  for (const expected of [`${VIEW_BASE}/state`, `${VIEW_BASE}/frame`, `${VIEW_BASE}/release`]) {
    if (!paths.includes(expected)) note(`route ${expected} is not registered (have: ${paths.join(', ')})`);
  }

  /** A minimal response: it records the status and the body. */
  const response = () => ({
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      this.headersSent = true;
    },
    end(payload) {
      this.body = payload === undefined ? '' : Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload);
    },
  });

  const stateRoute = routes.find((route) => route.path === `${VIEW_BASE}/state`);
  const allowed = response();
  stateRoute.handler({ method: 'GET', url: `${VIEW_BASE}/state`, headers: { host: '127.0.0.1:3080' } }, allowed);
  if (allowed.status !== 200) note(`state: status ${allowed.status}, expected 200`);
  if (JSON.parse(allowed.body || '{}').allowed?.[0] !== 4242) note('state: the answer carries no allowVmids');

  const foreignHost = response();
  stateRoute.handler({ method: 'GET', url: `${VIEW_BASE}/state`, headers: { host: 'pve.example.net' } }, foreignHost);
  if (foreignHost.status !== 403) note(`state: a foreign Host was not refused (status ${foreignHost.status})`);

  const crossSite = response();
  stateRoute.handler(
    { method: 'GET', url: `${VIEW_BASE}/state`, headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } },
    crossSite,
  );
  if (crossSite.status !== 403) note(`state: a cross-site request was not refused (status ${crossSite.status})`);

  const foreignOrigin = response();
  stateRoute.handler(
    { method: 'GET', url: `${VIEW_BASE}/state`, headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } },
    foreignOrigin,
  );
  if (foreignOrigin.status !== 403) note(`state: a foreign Origin was not refused (status ${foreignOrigin.status})`);

  const releaseRoute = routes.find((route) => route.path === `${VIEW_BASE}/release`);
  const wrongBody = response();
  releaseRoute.handler(
    { method: 'POST', url: `${VIEW_BASE}/release`, headers: { host: '127.0.0.1:3080', 'content-type': 'text/plain' } },
    wrongBody,
  );
  if (wrongBody.status !== 403) note(`release: a non-JSON body was not refused (status ${wrongBody.status})`);

  dispose();
  if (disposers !== routes.length) note(`the disposer removed ${disposers} of ${routes.length} routes`);
} catch (error) {
  note(`panel route check threw: ${error.stack ?? error}`);
}

// ── Display metadata: the card the panel paints ─────────────────────────────
// Before any activation the panel reads `locale/en.json` and every other
// `<language>.json` beside it, taking the text from their `meta` object
// (dsh-app-boot, readPluginMeta). A flat `{title, description}` file — what
// 0.2.0 shipped — is dropped without a word, and the card falls back to the
// package name; that silent downgrade is what this section catches.
const localeDir = new URL('../locale/', import.meta.url);
const localeFiles = fs
  .readdirSync(localeDir)
  .filter((name) => name.endsWith('.json'))
  .sort();
if (localeFiles.length === 0) note('locale/: no display metadata — the panel card falls back to the package name');

const localeFields = new Map();
for (const name of localeFiles) {
  const language = name.slice(0, -'.json'.length);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(new URL(name, localeDir), 'utf8'));
  } catch (error) {
    note(`locale/${name}: not valid JSON — ${error.message}`);
    continue;
  }
  const meta = parsed?.meta;
  if (meta === undefined) {
    note(`locale/${name}: no top-level "meta" — readPluginMeta drops the file and the card shows the package name`);
  }
  for (const field of ['title', 'description']) {
    const value = meta?.[field];
    if (typeof value !== 'string' || value.trim() === '') {
      note(`locale/${name}: meta.${field} must be a non-empty string`);
    }
  }
  localeFields.set(language, Object.keys(meta ?? {}).sort().join(','));
}
if (!localeFields.has('en')) note('locale/en.json is required — the reader keys every other language off it');
const shapes = new Set(localeFields.values());
if (shapes.size > 1) {
  const seen = [...localeFields].map(([language, fields]) => `${language}: ${fields || '(no fields)'}`).join('; ');
  note(`locale/: the files disagree on fields — ${seen}`);
}

// The reader itself, through the installed harness: it must answer with a
// translation map, not with the package-name fallback 0.2.0 produced.
try {
  const { readPluginMeta } = await import(`${DSH_PACKAGES}/dsh-app-boot/lib/index.js`);
  if (typeof readPluginMeta !== 'function') {
    note('this dsh has no readPluginMeta — the card metadata cannot be verified');
  } else {
    const manifestUrl = new URL('../package.json', import.meta.url);
    const manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8'));
    const meta = readPluginMeta(manifest.name, manifestUrl.href);
    if (meta === undefined) note('readPluginMeta returned nothing — the panel sees no card text at all');
    else {
      for (const field of ['title', 'description']) {
        const value = meta[field];
        if (typeof value === 'string') note(`readPluginMeta fell back to ${field} "${value}" — the locale files are not being read`);
        else {
          for (const language of localeFields.keys()) {
            if (value?.[language] === undefined) note(`readPluginMeta has no "${language}" ${field} — locale/${language}.json was not read`);
          }
        }
      }
    }
  }
} catch (error) {
  note(`the live metadata check could not run: ${error?.message ?? error}`);
}

const summary = {
  tools: registered.map((definition) => definition.name),
  count: registered.length,
  problems,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(problems.length === 0 ? 0 : 1);
