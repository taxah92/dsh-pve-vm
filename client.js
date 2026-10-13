/**
 * The browser half of `dsh-pve-vm`.
 *
 * Why it exists: on 0.2.x the `Config` schema reaches the host (it shows up in
 * `Config.listConfigs`), but only the client contribution paints the fields in the UI.
 * Without `./client` the plugin gets neither a "Configure" button nor a page —
 * the settings stay editable only through the profile patch layer.
 *
 * Here the "Proxmox VE" section registers into the `settings.section` slot, while reads and
 * writes go through the shared `configForms` service by the plugin's row id (`pve-vm`):
 * the edits land in the same profile patch layer as any other settings.
 *
 * The file format is a classic script from §4.2 of the project AGENTS.md: no `import`, no
 * `export`, everything needed comes in via `require` from the shell's base table.
 *
 * Labels come from `ctx.locale.bind(ns)`: it reads the active locale at call time
 * and unwraps the fallback chain itself. A locale snapshot is
 * `{ active, locales, revision }`, NOT `{ id }`; the first version of the card read
 * `getLocale().id`, got undefined and stayed English forever.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pve-vm',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');
    const { Button, Checkbox, Input } = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Settings namespace: must match the row id in cordis.patch.yml. */
    const NAMESPACE = 'pve-vm';
    /** Locale namespace of this card. */
    const LOCALE_NS = 'pve-vm-ui';

    const DICTIONARIES = {
      ru: {
        section: 'Proxmox VE',
        title: 'Виртуальные машины Proxmox VE',
        intro:
          'Плагин даёт агенту две руки в ВМ: консоль (кадр экрана, клики, клавиатура по VNC) и гостевой агент (команды, файлы). Настройки хранятся в патч-слое профиля.',
        statusReady: 'Настройки подключены — правки сохраняются в профиль.',
        statusReadOnly: 'Только чтение: хост не принимает записи настроек.',
        statusUnavailable: 'Настройки недоступны: пространство имён не опубликовано.',
        statusLoading: 'Загрузка настроек…',
        reset: 'сбросить',
        overridden: 'изменено',
        saveFailed: 'Не сохранилось',
        saved: 'Сохранено',
        'field.sshHost': 'Узел Proxmox',
        'field.sshHostHint': 'Алиас из ~/.ssh/config или адрес',
        'field.sshUser': 'Пользователь ssh',
        'field.sshPort': 'Порт ssh',
        'field.sshKeyPath': 'Ключ ssh',
        'field.sshKeyPathHint': 'Пусто — ключи по умолчанию',
        'field.sshConfigFile': 'Свой ssh-config',
        'field.sshConfigFileHint': 'Аналог ssh -F',
        'field.sshExtraOptions': 'Доп. опции ssh',
        'field.sshExtraOptionsHint': 'Опции -o, через запятую',
        'field.allowVmids': 'Разрешённые ВМ',
        'field.allowVmidsHint': 'ВМ, с которыми разрешено работать. Пустой список — запрещено всё.',
        'field.enableConsole': 'Инструменты консоли (VNC)',
        'field.enableGuest': 'Инструменты гостевого агента',
        'field.inputChannel': 'Канал ввода текста',
        'field.inputChannelHint':
          'auto — надёжный план: заглавные через Caps Lock (QEMU sendkey), остальное keysym; hmp — всё через sendkey (быстрее, но теряет модификаторы); vnc — только RFB keysym (верхний регистр ломается).',
        'channel.auto': 'auto — надёжный план',
        'channel.hmp': 'hmp — QEMU sendkey',
        'channel.vnc': 'vnc — только RFB keysym',
        'field.sendkeyDelayMs': 'Пауза между клавишами, мс',
        'field.sendkeyDelayMsHint':
          'Для каналов auto и hmp. 80 мс — проверенный темп; на 40 мс QEMU иногда теряет модификатор.',
        'field.consoleTimeoutMs': 'Таймаут консоли, мс',
        'field.sessionIdleMs': 'Простой сессии консоли, мс',
        'field.guestTimeoutMs': 'Таймаут команд агента, мс',
        'field.guestTypeCommand': 'Ввод не-ASCII в Linux-госте',
        'field.guestTypeCommandHint':
          'Скрипт ввода не-ASCII текста в Linux-госте; получает base64 текста первым аргументом.',
      },
      en: {
        section: 'Proxmox VE',
        title: 'Proxmox VE virtual machines',
        intro:
          'The plugin gives the agent two hands inside a VM: the console (screen frames, clicks, keyboard over VNC) and the guest agent (commands, files). Settings live in the profile patch layer.',
        statusReady: 'Settings are live — edits are written to the profile.',
        statusReadOnly: 'Read-only: this host does not accept settings writes.',
        statusUnavailable: 'Settings unavailable: the namespace is not published.',
        statusLoading: 'Loading settings…',
        reset: 'reset',
        overridden: 'overridden',
        saveFailed: 'Not saved',
        saved: 'Saved',
        'field.sshHost': 'Proxmox host',
        'field.sshHostHint': 'Alias from ~/.ssh/config, or an address',
        'field.sshUser': 'SSH user',
        'field.sshPort': 'SSH port',
        'field.sshKeyPath': 'SSH key',
        'field.sshKeyPathHint': 'Empty — default keys',
        'field.sshConfigFile': 'Custom ssh config',
        'field.sshConfigFileHint': 'Like ssh -F',
        'field.sshExtraOptions': 'Extra ssh options',
        'field.sshExtraOptionsHint': '-o options, comma separated',
        'field.allowVmids': 'Allowed VMs',
        'field.allowVmidsHint': 'VMs the plugin may touch. An empty list forbids everything.',
        'field.enableConsole': 'Console tools (VNC)',
        'field.enableGuest': 'Guest-agent tools',
        'field.inputChannel': 'Text input channel',
        'field.inputChannelHint':
          'auto — reliable plan: uppercase via Caps Lock (QEMU sendkey), the rest by keysym; hmp — everything through sendkey (faster, but loses modifiers); vnc — RFB keysym only (uppercase breaks).',
        'channel.auto': 'auto — reliable plan',
        'channel.hmp': 'hmp — QEMU sendkey',
        'channel.vnc': 'vnc — RFB keysym only',
        'field.sendkeyDelayMs': 'Key delay, ms',
        'field.sendkeyDelayMsHint':
          'For the auto and hmp channels. 80 ms is the verified pace; at 40 ms QEMU sometimes drops a modifier.',
        'field.consoleTimeoutMs': 'Console timeout, ms',
        'field.sessionIdleMs': 'Console idle timeout, ms',
        'field.guestTimeoutMs': 'Guest command timeout, ms',
        'field.guestTypeCommand': 'Non-ASCII typing in a Linux guest',
        'field.guestTypeCommandHint':
          'Script that types non-ASCII text inside a Linux guest; receives base64 text as $1.',
      },
    };

    /** Choice options for the text input channel field. */
    const CHANNEL_CHOICES = [
      { value: 'auto', labelKey: 'channel.auto' },
      { value: 'hmp', labelKey: 'channel.hmp' },
      { value: 'vnc', labelKey: 'channel.vnc' },
    ];

    /** Card fields: setting name, input kind and dictionary keys. */
    const FIELDS = [
      { name: 'sshHost', kind: 'text' },
      { name: 'sshUser', kind: 'text' },
      { name: 'sshPort', kind: 'number' },
      { name: 'sshKeyPath', kind: 'text', hintKey: 'field.sshKeyPathHint' },
      { name: 'sshConfigFile', kind: 'text', hintKey: 'field.sshConfigFileHint' },
      { name: 'sshExtraOptions', kind: 'list', hintKey: 'field.sshExtraOptionsHint' },
      { name: 'allowVmids', kind: 'numberList', hintKey: 'field.allowVmidsHint' },
      { name: 'enableConsole', kind: 'boolean' },
      { name: 'enableGuest', kind: 'boolean' },
      { name: 'inputChannel', kind: 'choice', choices: CHANNEL_CHOICES, hintKey: 'field.inputChannelHint' },
      { name: 'sendkeyDelayMs', kind: 'number', hintKey: 'field.sendkeyDelayMsHint' },
      { name: 'consoleTimeoutMs', kind: 'number' },
      { name: 'sessionIdleMs', kind: 'number' },
      { name: 'guestTimeoutMs', kind: 'number' },
      { name: 'guestTypeCommand', kind: 'textarea', hintKey: 'field.guestTypeCommandHint' },
    ];

    const STYLE_ID = 'dsh-pve-vm-styles';
    const STYLES = `
.pve-vm-section { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 18px; color: var(--dsw-alias-label-primary); }
.pve-vm-title { font-size: 15px; font-weight: 600; }
.pve-vm-intro { font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); max-width: 68ch; }
.pve-vm-status { font-size: 12px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.pve-vm-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.pve-vm-status[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.pve-vm-row { display: grid; grid-template-columns: minmax(180px, 240px) 1fr; gap: 10px 16px; align-items: start; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.pve-vm-row:first-of-type { border-top: none; }
.pve-vm-label { font-size: 13px; padding-top: 7px; }
.pve-vm-flag { margin-left: 6px; font-size: 11px; color: var(--dsw-alias-brand-primary); }
.pve-vm-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary); margin-top: 6px; line-height: 1.45; max-width: 62ch; }
.pve-vm-controls { display: flex; flex-direction: column; gap: 6px; }
.pve-vm-inline { display: flex; align-items: center; gap: 8px; }
.pve-vm-select, .pve-vm-textarea { width: 100%; font: inherit; font-size: 12.5px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.pve-vm-textarea { min-height: 96px; resize: vertical; }
.pve-vm-select:focus, .pve-vm-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
`;

    /** Add the card styles once. */
    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {};
      const element = document.createElement('style');
      element.id = STYLE_ID;
      element.textContent = STYLES;
      document.head.append(element);
      return () => element.remove();
    }

    /** Field value to its input representation. */
    function toInput(field, value) {
      if (field.kind === 'list' || field.kind === 'numberList') return Array.isArray(value) ? value.join(', ') : '';
      if (value === undefined || value === null) return '';
      return String(value);
    }

    /** Input to a setting value; undefined means "leave it alone". */
    function fromInput(field, text) {
      if (field.kind === 'number') {
        const parsed = Number(text.trim());
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      if (field.kind === 'list') {
        return text
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
      }
      if (field.kind === 'numberList') {
        return text
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((value) => Number.isInteger(value) && value > 0);
      }
      return text;
    }

    /**
     * The section card: reads and writes one settings row through configForms.
     * @param {{ctx: object, t: Function}} props slot-owner props plus the translator from inject.
     */
    function PveVmSection(props) {
      const ctx = props.ctx;
      const t = props.t;
      const form = React.useMemo(() => ctx.configForms.get(NAMESPACE), [ctx]);
      const [snapshot, setSnapshot] = React.useState(() => form.getSnapshot());
      const [draft, setDraft] = React.useState({});
      const [note, setNote] = React.useState(null);
      const [, setLocaleTick] = React.useState(0);

      React.useEffect(() => form.subscribe(() => setSnapshot(form.getSnapshot())), [form]);
      // A language change must repaint the field labels, not just the section name.
      React.useEffect(() => {
        const unsubscribe = ctx.locale.subscribe?.(() => setLocaleTick((tick) => tick + 1));
        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
      }, [ctx]);

      const values = snapshot.value ?? {};
      const userLayer = snapshot.user ?? {};
      const writable = snapshot.writable === true && snapshot.status === 'ready';

      const status =
        snapshot.status === 'loading'
          ? { tone: 'idle', text: t('statusLoading') }
          : snapshot.status === 'unavailable'
            ? { tone: 'error', text: t('statusUnavailable') }
            : writable
              ? { tone: 'ok', text: t('statusReady') }
              : { tone: 'idle', text: t('statusReadOnly') };

      /** Write a field and show the outcome. */
      const commit = async (field, raw) => {
        const value = fromInput(field, raw);
        if (value === undefined) return;
        try {
          const accepted = await form.set(field.name, value);
          setNote(accepted ? t('saved') : t('saveFailed'));
        } catch {
          setNote(t('saveFailed'));
        }
        setTimeout(() => setNote(null), 2500);
      };

      const rows = FIELDS.map((field) => {
        const current = draft[field.name] ?? toInput(field, values[field.name]);
        const overridden = Object.hasOwn(userLayer, field.name);
        const hint = field.hintKey ? t(field.hintKey) : undefined;
        const label = jsxs('div', {
          className: 'pve-vm-label',
          children: [
            t('field.' + field.name),
            overridden ? jsx('span', { className: 'pve-vm-flag', children: t('overridden') }) : null,
          ],
        });

        let control;
        if (field.kind === 'boolean') {
          control = jsx(Checkbox, {
            checked: values[field.name] !== false,
            disabled: !writable,
            label: '',
            onChange: (next) => commit(field, String(next)),
          });
        } else if (field.kind === 'choice') {
          control = jsx('select', {
            className: 'pve-vm-select',
            value: String(values[field.name] ?? field.choices[0].value),
            disabled: !writable,
            onChange: (event) => commit(field, event.target.value),
            children: field.choices.map((choice) =>
              jsx('option', { value: choice.value, children: t(choice.labelKey) }, choice.value),
            ),
          });
        } else if (field.kind === 'textarea') {
          control = jsx('textarea', {
            className: 'pve-vm-textarea',
            value: current,
            disabled: !writable,
            spellCheck: false,
            onChange: (event) => setDraft((state) => ({ ...state, [field.name]: event.target.value })),
            onBlur: (event) => commit(field, event.target.value),
          });
        } else {
          control = jsx(Input, {
            value: current,
            disabled: !writable,
            spellCheck: false,
            inputMode: field.kind === 'number' || field.kind === 'numberList' ? 'numeric' : undefined,
            onChange: (event) => setDraft((state) => ({ ...state, [field.name]: event.target.value })),
            onBlur: (event) => commit(field, event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            },
          });
        }

        return jsxs(
          'div',
          {
            className: 'pve-vm-row',
            children: [
              label,
              jsxs('div', {
                className: 'pve-vm-controls',
                children: [
                  jsxs('div', {
                    className: 'pve-vm-inline',
                    children: [
                      control,
                      overridden && writable
                        ? jsx(Button, {
                            variant: 'ghost',
                            size: 'sm',
                            children: t('reset'),
                            onClick: async () => {
                              setDraft((state) => {
                                const next = { ...state };
                                delete next[field.name];
                                return next;
                              });
                              try {
                                await form.unset(field.name);
                              } catch {
                                setNote(t('saveFailed'));
                              }
                            },
                          })
                        : null,
                    ],
                  }),
                  hint ? jsx('div', { className: 'pve-vm-hint', children: hint }) : null,
                ],
              }),
            ],
          },
          field.name,
        );
      });

      return jsxs('div', {
        className: 'pve-vm-section',
        children: [
          jsx('div', { className: 'pve-vm-title', children: t('title') }),
          jsx('div', { className: 'pve-vm-intro', children: t('intro') }),
          jsxs('div', {
            className: 'pve-vm-status',
            'data-tone': status.tone,
            children: [status.text, note ? ' · ' + note : ''],
          }),
          ...rows,
        ],
      });
    }

    /**
     * Attach the card to the settings section.
     * @param {object} ctx the client context.
     */
    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-pve-vm: styles');
      ctx.effect(() => {
        const disposers = Object.entries(DICTIONARIES).map(([locale, dict]) =>
          ctx.locale.register(LOCALE_NS, locale, dict),
        );
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, 'dsh-pve-vm: dictionaries');

      // bind reads the active locale at call time and unwraps the fallbacks itself.
      const translate = () => ctx.locale.bind(LOCALE_NS);
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NAMESPACE,
            order: 30,
            label: () => translate()('section'),
            inject: () => ({ ctx, t: translate() }),
          },
          PveVmSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'configForms'];
    return module.exports;
  },
});
