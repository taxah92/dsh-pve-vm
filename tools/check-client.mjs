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
      const slotNames = [];
      const registrations = [];
      const tabTypes = [];
      const scopedInjections = [];
      const openTabs = [];
      const locale = {
        register: (ns, localeId, dict) => {
          dictionaries.push(`${ns}/${localeId}`);
          if (typeof dict !== 'object') note(`dictionary ${ns}/${localeId} is not an object`);
          return () => {};
        },
        getLocale: () => ({ active: 'ru', locales: [], revision: 1 }),
        subscribe: () => () => {},
        // bind is the standard translation path: it reads the active locale on each call.
        bind: (ns) => (key) => `${ns}:${key}`,
      };
      const slots = {
        inject: (slot, callback) => {
          slotNames.push(slot);
          callback();
          return () => {};
        },
        register: (registration, component) => {
          registrations.push({ registration, component });
          return () => {};
        },
      };
      const configForms = {
        get: () => ({ getSnapshot: () => ({ status: 'ready', value: {}, writable: true }), subscribe: () => () => {} }),
      };
      const sidebarRight = {
        mounted: { getSnapshot: () => 'session-1', subscribe: () => () => {} },
        openTabIn: (sessionId, kind) => openTabs.push({ sessionId, kind }),
      };
      const sidebarRightTabs = { register: (definition) => (tabTypes.push(definition), () => {}) };
      const ctx = {
        effect: (fn, label) => {
          effects.push(label ?? '(no label)');
          const disposer = fn();
          return typeof disposer === 'function' ? disposer : () => {};
        },
        locale,
        slots,
        configForms,
        // ctx.inject is the declared dependency on the right sidebar: the callback
        // receives a scoped context and its disposer runs when the plugin unloads.
        inject: (services, callback) => {
          scopedInjections.push(services.join('+'));
          const dispose = callback({ slots, sidebarRight, sidebarRightTabs, locale, configForms });
          return typeof dispose === 'function' ? dispose : () => {};
        },
      };
      try {
        module.apply(ctx);
      } catch (error) {
        note(`apply threw: ${error.stack ?? error}`);
      }
      if (slotNames.length === 0) note('the card did not subscribe to any slot');
      for (const slot of slotNames) {
        if (!['settings.section', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'].includes(slot)) {
          note(`unexpected slot "${slot}"`);
        }
      }
      for (const expected of ['settings.section', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
        if (!slotNames.includes(expected)) note(`nothing registers into the slot "${expected}"`);
      }
      if (!scopedInjections.some((entry) => entry.includes('sidebarRight') && entry.includes('sidebarRightTabs'))) {
        note('the panel reads sidebarRight/sidebarRightTabs without declaring them through ctx.inject');
      }
      if (dictionaries.length < 2) note(`dictionaries registered: ${dictionaries.length} (expected ru and en)`);
      if (effects.length === 0) note('apply registered no effect');
      if (tabTypes.length !== 1) note(`tab types registered: ${tabTypes.length} (expected one)`);
      for (const definition of tabTypes) {
        if (definition.id !== 'dsh-pve-vm/console') note(`tab type id "${definition.id}"`);
        if (typeof definition.kind !== 'string' || definition.kind.length === 0) note('the tab type has no kind');
        if (typeof definition.title !== 'function') note('the tab type has no title');
        if (!Array.isArray(definition.guide) || definition.guide.length === 0) note('the tab type will not appear in the sidebar guide');
      }
      for (const { registration, component } of registrations) {
        if (typeof component !== 'function') note('the second argument of register is not a component');
        if (registration.name === 'settings.section') {
          if (registration.id !== 'pve-vm') note(`card id "${registration.id}", expected pve-vm (== the patch entry id)`);
          if (typeof registration.label !== 'function' && typeof registration.label !== 'string') note('the card has no label');
          if (typeof registration.inject !== 'function') note('registration without inject: the card will get neither ctx nor the translator');
          else if (typeof registration.inject().ctx !== 'object') note('inject does not return ctx');
          continue;
        }
        // The tab body and its title register under the tab type's key.
        if (registration.key !== 'dsh-pve-vm/console') note(`tab key "${registration.key}" does not match the type id`);
        if (registration.locale !== 'pve-vm-ui') note(`the tab declares no dictionary: locale = ${registration.locale}`);
        if (registration.name === 'sidebar.right.pane.tab') {
          if (typeof registration.inject !== 'function') note('the tab body has no inject');
          else {
            const injected = registration.inject();
            if (typeof injected.ctx !== 'object') note('the tab body does not receive ctx');
            if (typeof injected.form?.getSnapshot !== 'function') note('the tab body does not receive the settings form');
          }
        }
      }
      // Auto-open must not fire on the very first state read: otherwise every page
      // reload would open the tab because of the agent's older work.
      if (openTabs.length !== 0) note('the tab auto-opened before the first agent mark');
    }
  }
}

process.stdout.write(`${JSON.stringify({ problems }, null, 2)}\n`);
process.exit(problems.length === 0 ? 0 : 1);
