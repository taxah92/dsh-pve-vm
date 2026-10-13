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
  consoleTimeoutMs: 20000,
  sessionIdleMs: 300000,
  guestTimeoutMs: 60000,
  guestTypeCommand: 'echo {base64}',
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
  // The settings service hands `.volatile()` fields out as live references even on a direct schema call.
  if (resolved.sshHost?.get?.() !== 'proxmox') note('Config: sshHost was not applied');
} catch (error) {
  note(`settings check threw: ${error.stack ?? error}`);
}

const summary = {
  tools: registered.map((definition) => definition.name),
  count: registered.length,
  problems,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exit(problems.length === 0 ? 0 : 1);
