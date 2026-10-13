#!/usr/bin/env node
/**
 * Pre-install check of the browser half: a loader stub captures the bundle
 * registration, `factory(stubRequire)` returns the module, and `apply` is run
 * against a fake client context.
 *
 *   node tools/check-client.mjs
 *
 * It catches exactly the mistakes that otherwise take the panel down: `import`/`export`
 * instead of a classic script, a truthy `default`, a lost `return module.exports`,
 * registration into the wrong slot, an absent `inject`.
 */
import fs from 'node:fs';
import process from 'node:process';

const problems = [];
const note = (message) => problems.push(message);

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry;
    },
  },
};
// The card styles are injected only on render, but the stub is needed in case
// installStyles is called directly by the check.
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove() {} }),
  head: { append() {} },
};

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
if (/^\s*(import|export)\s/m.test(source)) note('client.js contains import/export — the bundle must be a classic script');
if (!source.includes('return module.exports')) note('client.js does not return module.exports');

await import('../client.js');

if (captured === null) note('the bundle did not call window.__ModuleLoader__.load');
else {
  if (captured.id !== 'dsh-pve-vm') note(`bundle id "${captured.id}", expected dsh-pve-vm`);
  const stubs = {
    react: { useState: () => [undefined, () => {}], useMemo: (fn) => fn(), useEffect: () => {} },
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    },
    '@deepseek-ai/dsh-client-ui-primitives': {
      Button: () => null,
      Checkbox: () => null,
      Input: () => null,
    },
  };
  let module;
  try {
    module = captured.factory((name) => {
      if (!Object.hasOwn(stubs, name)) throw new Error(`unknown require("${name}")`);
      return stubs[name];
    });
  } catch (error) {
    note(`factory threw: ${error.message}`);
  }
  if (module !== undefined) {
    if (typeof module.apply !== 'function') note('no apply export');
    if (module.default !== undefined) note('truthy default in the exports — cordis will mistake it for a plugin');
    const services = Array.isArray(module.inject) ? module.inject : [];
    for (const required of ['slots', 'locale', 'configForms']) {
      if (!services.includes(required)) note(`the inject list is missing the service "${required}"`);
    }
    if (typeof module.apply === 'function') {
      const effects = [];
      const dictionaries = [];
      const slots = [];
      const registrations = [];
      const ctx = {
        effect: (fn, label) => {
          effects.push(label ?? '(no label)');
          const disposer = fn();
          return typeof disposer === 'function' ? disposer : () => {};
        },
        locale: {
          register: (ns, locale, dict) => {
            dictionaries.push(`${ns}/${locale}`);
            if (typeof dict !== 'object') note(`dictionary ${ns}/${locale} is not an object`);
            return () => {};
          },
          getLocale: () => ({ active: 'ru', locales: [], revision: 1 }),
          subscribe: () => () => {},
          // bind is the standard translation path: it reads the active locale on each call.
          bind: (ns) => (key) => `${ns}:${key}`,
        },
        slots: {
          inject: (slot, callback) => {
            slots.push(slot);
            callback();
          },
          register: (registration, component) => {
            registrations.push({ registration, component });
            return () => {};
          },
        },
        configForms: { get: () => ({ getSnapshot: () => ({ status: 'ready', value: {}, writable: true }) }) },
      };
      try {
        module.apply(ctx);
      } catch (error) {
        note(`apply threw: ${error.stack ?? error}`);
      }
      if (slots.length === 0) note('the card did not subscribe to any slot');
      for (const slot of slots) {
        if (slot !== 'settings.section') note(`unexpected slot "${slot}" (expected settings.section)`);
      }
      if (dictionaries.length < 2) note(`dictionaries registered: ${dictionaries.length} (expected ru and en)`);
      if (effects.length === 0) note('apply registered no effect');
      for (const { registration, component } of registrations) {
        if (registration.id !== 'pve-vm') note(`card id "${registration.id}", expected pve-vm (== the patch entry id)`);
        if (typeof registration.label !== 'function' && typeof registration.label !== 'string') note('the card has no label');
        if (typeof registration.inject !== 'function') note('registration without inject: the card will get neither ctx nor the translator');
        else if (typeof registration.inject().ctx !== 'object') note('inject does not return ctx');
        if (typeof component !== 'function') note('the second argument of register is not a component');
      }
    }
  }
}

process.stdout.write(`${JSON.stringify({ problems }, null, 2)}\n`);
process.exit(problems.length === 0 ? 0 : 1);
