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
        'field.viewAutoOpen': 'Открывать панель экрана сама',
        'field.viewAutoOpenHint':
          'Когда агент прикасается к консоли ВМ, вкладка «Экран ВМ» раскрывается сама в правом сайдбаре.',
        'field.viewFollowAgent': 'Панель следует за агентом',
        'field.viewFollowAgentHint':
          'Показывать ВМ, с которой работает агент. Выключено — панель держит ВМ, выбранную вручную.',
        'field.viewFps': 'Кадров в секунду в панели',
        'field.viewFpsHint':
          '1–4. Два кадра в секунду — рабочий темп: движение агента видно, узел не перегружен.',
        'field.viewScale': 'Делитель разрешения кадра',
        'field.viewScaleHint':
          '1 — нативное, 2 — половина (по умолчанию), 4 — четверть. Меньше пикселей — быстрее кадр.',
        'tab.title': 'Экран ВМ',
        'tab.guide': 'Смотреть экран виртуальной машины, пока агент с ней работает.',
        'view.follow': 'следовать за агентом',
        'view.pause': 'пауза',
        'view.play': 'смотреть',
        'view.snap': 'кадр сейчас',
        'view.release': 'отключить консоль',
        'view.released': 'сессия консоли закрыта',
        'view.releaseFailed': 'закрыть сессию не удалось',
        'view.fps': 'кадров/с',
        'view.scale': 'разрешение',
        'view.scaleNative': 'нативное',
        'view.scaleHalf': 'половина',
        'view.scaleQuarter': 'четверть',
        'view.empty': 'В allowVmids нет ни одной ВМ — добавьте её в настройках плагина.',
        'view.consoleOff': 'Инструменты консоли выключены настройкой enableConsole.',
        'view.waiting': 'Ждём первый кадр…',
        'view.paused': 'поток на паузе',
        'view.blank': 'Кадр почти одноцветный: гость погасил дисплей или экран заблокирован.',
        'view.closed': 'сессия консоли закрылась — следующий кадр откроет её заново',
        'view.status': 'ВМ {vmid} · экран {resolution} · кадр {capture} · курсор {pointer}',
        'view.bytes': '{kb} КБ',
        'view.hostError': 'хост ответил ошибкой: {message}',
        'view.noHost': 'нет связи с хостом: {message}',
        'view.agentVm': 'агент работал с ВМ {vmid}',
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
        'field.viewAutoOpen': 'Open the screen panel by itself',
        'field.viewAutoOpenHint':
          'When the agent touches a VM console, the “VM screen” tab opens itself in the right sidebar.',
        'field.viewFollowAgent': 'Panel follows the agent',
        'field.viewFollowAgentHint':
          'Show the VM the agent is working with. Off — the panel keeps the VM you picked by hand.',
        'field.viewFps': 'Frames per second in the panel',
        'field.viewFpsHint':
          '1–4. Two frames per second is the working pace: the agent’s moves are visible, the node stays calm.',
        'field.viewScale': 'Frame resolution divisor',
        'field.viewScaleHint':
          '1 — native, 2 — half (default), 4 — quarter. Fewer pixels — faster frame.',
        'tab.title': 'VM screen',
        'tab.guide': 'Watch the virtual machine screen while the agent works with it.',
        'view.follow': 'follow the agent',
        'view.pause': 'pause',
        'view.play': 'watch',
        'view.snap': 'frame now',
        'view.release': 'disconnect console',
        'view.released': 'console session closed',
        'view.releaseFailed': 'could not close the session',
        'view.fps': 'frames/s',
        'view.scale': 'resolution',
        'view.scaleNative': 'native',
        'view.scaleHalf': 'half',
        'view.scaleQuarter': 'quarter',
        'view.empty': 'No VM is allowed yet — add one in the plugin settings.',
        'view.consoleOff': 'Console tools are disabled by the enableConsole setting.',
        'view.waiting': 'Waiting for the first frame…',
        'view.paused': 'stream paused',
        'view.blank': 'The frame is almost one colour: the guest blanked the display or the screen is locked.',
        'view.closed': 'the console session closed — the next frame opens it again',
        'view.status': 'VM {vmid} · screen {resolution} · frame {capture} · pointer {pointer}',
        'view.bytes': '{kb} KB',
        'view.hostError': 'the host answered with an error: {message}',
        'view.noHost': 'no connection to the host: {message}',
        'view.agentVm': 'the agent worked with VM {vmid}',
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
      { name: 'viewAutoOpen', kind: 'boolean', hintKey: 'field.viewAutoOpenHint' },
      { name: 'viewFollowAgent', kind: 'boolean', hintKey: 'field.viewFollowAgentHint' },
      { name: 'viewFps', kind: 'number', hintKey: 'field.viewFpsHint' },
      { name: 'viewScale', kind: 'number', hintKey: 'field.viewScaleHint' },
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
.pve-vm-view { display: flex; flex-direction: column; gap: 10px; padding: 10px 10px 16px; color: var(--dsw-alias-label-primary); font-size: 12.5px; }
.pve-vm-view-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pve-vm-chip { font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); cursor: pointer; }
.pve-vm-chip[data-active="1"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.pve-vm-stage { display: flex; align-items: center; justify-content: center; min-height: 110px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.pve-vm-stage img { display: block; width: 100%; height: auto; }
.pve-vm-stage-empty { padding: 22px 14px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.pve-vm-line { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.45; }
.pve-vm-warn { border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); border-radius: 8px; padding: 6px 9px; font-size: 11.5px; line-height: 1.45; }
.pve-vm-error { border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 6px 9px; font-size: 11.5px; line-height: 1.45; }
.pve-vm-ok { color: var(--dsw-alias-state-success-primary); font-size: 11.5px; }
.pve-vm-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pve-vm-tools .pve-vm-select { width: auto; }
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

    /** The tab type id: it is also the key in the right sidebar slots. */
    const TAB_ID = 'dsh-pve-vm/console';
    /** The tab type discriminator: tabs are opened by this name. */
    const TAB_KIND = 'pve-vm-console';
    /** Base path of the panel routes on the host (lib/routes.js). */
    const VIEW_BASE = '/pve-vm/console';
    /** How often the panel asks the node for its state, ms. */
    const STATE_POLL_MS = 2500;
    /** How often the plugin checks "the agent touched a console" for auto-open, ms. */
    const AUTO_OPEN_POLL_MS = 3000;

    /**
     * Panel settings from the same form as `settings.section`.
     * The bounds are the host's `resolveSettings` bounds: a value typed by a human
     * may be anything, while the frame has to stay predictable.
     * @param {object} snapshot the configForms snapshot.
     * @returns {{autoOpen:boolean, followAgent:boolean, fps:number, scale:number}}
     */
    function viewDefaults(snapshot) {
      const values = snapshot?.value ?? {};
      const clamp = (value, min, max, fallback) => {
        const parsed = Math.round(Number(value));
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(min, Math.min(max, parsed));
      };
      return {
        autoOpen: values.viewAutoOpen === true,
        followAgent: values.viewFollowAgent !== false,
        fps: clamp(values.viewFps, 1, 4, 2),
        scale: clamp(values.viewScale, 1, 4, 2),
      };
    }

    /**
     * What the panel shows right now. Both the tab body and its chip need it: the
     * chip is drawn by a separate slot and knows nothing about component state.
     */
    const viewStore = {
      vmid: null,
      listeners: new Set(),
      set(vmid) {
        if (this.vmid === vmid) return;
        this.vmid = vmid;
        for (const listener of [...this.listeners]) listener();
      },
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
    };

    /** Frame metadata from the route response headers. */
    function readFrameMeta(headers) {
      return {
        resolution: headers.get('x-pve-vm-resolution'),
        capture: headers.get('x-pve-vm-capture'),
        scale: Number(headers.get('x-pve-vm-scale') ?? 1),
        pointer: headers.get('x-pve-vm-pointer'),
        blank: headers.get('x-pve-vm-blank') === '1',
        session: headers.get('x-pve-vm-session'),
      };
    }

    /** The tab chip: "VM screen · 121". */
    function ConsoleTitle(props) {
      const t = props.t;
      const [vmid, setVmid] = React.useState(viewStore.vmid);
      React.useEffect(() => viewStore.subscribe(() => setVmid(viewStore.vmid)), []);
      return jsx('span', { children: vmid === null ? t('tab.title') : `${t('tab.title')} · ${vmid}` });
    }

    /**
     * The observation panel: a live VM screen in the right sidebar.
     *
     * Frames come from the plugin's routes (`/pve-vm/console/frame`) — the very
     * frames the agent sees, taken from its RFB session. The stream runs while the
     * tab is visible and not paused; the next frame is requested only after the
     * previous one arrived, so the session queue is never flooded.
     * @param {{t:Function, ctx:object, form:object, useTabInfo?:Function}} props the slot props.
     */
    function ConsolePane(props) {
      const t = props.t;
      const form = props.form;
      const tab = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null;
      const visible = tab?.tab?.visible !== false;

      const [settings, setSettings] = React.useState(() => viewDefaults(form.getSnapshot()));
      const [state, setState] = React.useState(null);
      const [stateError, setStateError] = React.useState(null);
      const [follow, setFollow] = React.useState(null);
      const [manualVmid, setManualVmid] = React.useState(null);
      const [streaming, setStreaming] = React.useState(true);
      const [fps, setFps] = React.useState(null);
      const [scale, setScale] = React.useState(null);
      const [frame, setFrame] = React.useState(null);
      const [frameError, setFrameError] = React.useState(null);
      const [note, setNote] = React.useState(null);
      const [tick, setTick] = React.useState(0);
      const frameUrl = React.useRef(null);
      const [, setLocaleTick] = React.useState(0);

      React.useEffect(() => form.subscribe(() => setSettings(viewDefaults(form.getSnapshot()))), [form]);
      // A language change must repaint the panel labels, not just its title.
      React.useEffect(() => {
        const unsubscribe = props.ctx.locale.subscribe?.(() => setLocaleTick((value) => value + 1));
        return typeof unsubscribe === 'function' ? unsubscribe : undefined;
      }, [props.ctx]);

      // Node state: the allowed VMs, live sessions and whom to follow.
      React.useEffect(() => {
        if (!visible) return undefined;
        let cancelled = false;
        let timer;
        const poll = async () => {
          try {
            const response = await fetch(`${VIEW_BASE}/state`, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            });
            const body = await response.json().catch(() => ({}));
            if (cancelled) return;
            if (response.ok) {
              setState(body);
              setStateError(null);
            } else {
              setStateError(body.error ?? `HTTP ${response.status}`);
            }
          } catch (error) {
            if (!cancelled) setStateError(String(error?.message ?? error));
          } finally {
            if (!cancelled) timer = setTimeout(poll, STATE_POLL_MS);
          }
        };
        poll();
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [visible]);

      const followAgent = follow ?? settings.followAgent;
      const fpsEff = fps ?? settings.fps;
      const scaleEff = scale ?? settings.scale;
      const allowed = Array.isArray(state?.allowed) ? state.allowed : [];
      const lastVmid = state?.last?.vmid ?? null;
      const preferred = followAgent ? lastVmid : manualVmid;
      const vmid = allowed.includes(preferred)
        ? preferred
        : allowed.includes(manualVmid)
          ? manualVmid
          : (allowed[0] ?? null);

      React.useEffect(() => viewStore.set(vmid), [vmid]);

      // The frame stream: the next request only after the previous answer.
      React.useEffect(() => {
        if (!visible || !streaming || vmid === null) return undefined;
        let cancelled = false;
        let timer;
        const step = async () => {
          const started = Date.now();
          try {
            const response = await fetch(`${VIEW_BASE}/frame?vmid=${vmid}&scale=${scaleEff}&cursor=1`, {
              cache: 'no-store',
            });
            if (!response.ok) {
              const body = await response.json().catch(() => ({}));
              throw new Error(body.error ?? `HTTP ${response.status}`);
            }
            const blob = await response.blob();
            if (cancelled) return;
            const next = URL.createObjectURL(blob);
            if (frameUrl.current !== null) URL.revokeObjectURL(frameUrl.current);
            frameUrl.current = next;
            setFrame({ url: next, meta: readFrameMeta(response.headers), bytes: blob.size, at: Date.now() });
            setFrameError(null);
          } catch (error) {
            if (!cancelled) setFrameError(String(error?.message ?? error));
          } finally {
            if (!cancelled) {
              const wait = Math.max(80, Math.round(1000 / fpsEff) - (Date.now() - started));
              timer = setTimeout(step, wait);
            }
          }
        };
        step();
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [visible, streaming, vmid, scaleEff, fpsEff, tick]);

      // The last frame lives in a blob URL: it must be released when the panel unloads.
      React.useEffect(
        () => () => {
          if (frameUrl.current !== null) URL.revokeObjectURL(frameUrl.current);
        },
        [],
      );

      /** Close the VM console session on the node. */
      const release = async () => {
        try {
          const response = await fetch(`${VIEW_BASE}/release`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ vmid }),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setNote(t('view.released'));
        } catch {
          setNote(t('view.releaseFailed'));
        }
        setTimeout(() => setNote(null), 2500);
      };

      const chips = allowed.map((id) =>
        jsx(
          'button',
          {
            type: 'button',
            className: 'pve-vm-chip',
            'data-active': id === vmid ? '1' : '0',
            onClick: () => {
              setManualVmid(id);
              setFollow(false);
            },
            children: String(id),
          },
          id,
        ),
      );

      const banners = [];
      if (stateError !== null) {
        banners.push(jsx('div', { className: 'pve-vm-error', children: t('view.noHost', { message: stateError }) }, 'state'));
      }
      if (state?.consoleEnabled === false) {
        banners.push(jsx('div', { className: 'pve-vm-warn', children: t('view.consoleOff') }, 'console'));
      }
      if (allowed.length === 0 && state !== null) {
        banners.push(jsx('div', { className: 'pve-vm-warn', children: t('view.empty') }, 'empty'));
      }
      if (frameError !== null) {
        banners.push(jsx('div', { className: 'pve-vm-error', children: t('view.hostError', { message: frameError }) }, 'frame'));
      }
      if (frame?.meta?.blank === true) {
        banners.push(jsx('div', { className: 'pve-vm-warn', children: t('view.blank') }, 'blank'));
      }
      if (frame?.meta?.session === 'closed') {
        banners.push(jsx('div', { className: 'pve-vm-warn', children: t('view.closed') }, 'closed'));
      }
      if (!streaming) {
        banners.push(jsx('div', { className: 'pve-vm-line', children: t('view.paused') }, 'paused'));
      }

      const status =
        frame === null
          ? null
          : `${t('view.status', {
              vmid: String(vmid ?? '—'),
              resolution: frame.meta.resolution ?? '—',
              capture: frame.meta.capture ?? '—',
              pointer: frame.meta.pointer ?? '—',
            })} · ${t('view.bytes', { kb: String(Math.max(1, Math.round(frame.bytes / 1024))) })}`;

      return jsxs('div', {
        className: 'pve-vm-view',
        children: [
          jsxs('div', {
            className: 'pve-vm-view-head',
            children: [
              ...chips,
              lastVmid !== null
                ? jsx('span', { className: 'pve-vm-line', children: t('view.agentVm', { vmid: String(lastVmid) }) })
                : null,
            ],
          }),
          jsx('div', {
            className: 'pve-vm-stage',
            children:
              frame === null
                ? jsx('div', {
                    className: 'pve-vm-stage-empty',
                    children: allowed.length === 0 ? t('view.empty') : t('view.waiting'),
                  })
                : jsx('img', { src: frame.url, alt: '' }),
          }),
          status === null ? null : jsx('div', { className: 'pve-vm-line', children: status }),
          ...banners,
          jsxs('div', {
            className: 'pve-vm-tools',
            children: [
              jsx(Button, {
                variant: 'outline',
                size: 'sm',
                children: streaming ? t('view.pause') : t('view.play'),
                onClick: () => setStreaming((value) => !value),
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'sm',
                disabled: vmid === null,
                children: t('view.snap'),
                onClick: () => setTick((value) => value + 1),
              }),
              jsx(Button, {
                variant: 'ghost',
                size: 'sm',
                disabled: vmid === null,
                children: t('view.release'),
                onClick: release,
              }),
              jsx(Checkbox, {
                checked: followAgent,
                label: t('view.follow'),
                onChange: (next) => setFollow(next),
              }),
              jsx('select', {
                className: 'pve-vm-select',
                value: String(fpsEff),
                title: t('view.fps'),
                onChange: (event) => setFps(Number(event.target.value)),
                children: [1, 2, 3, 4].map((value) =>
                  jsx('option', { value: String(value), children: `${value} ${t('view.fps')}` }, value),
                ),
              }),
              jsx('select', {
                className: 'pve-vm-select',
                value: String(scaleEff),
                title: t('view.scale'),
                onChange: (event) => setScale(Number(event.target.value)),
                children: [
                  { value: 1, key: 'view.scaleNative' },
                  { value: 2, key: 'view.scaleHalf' },
                  { value: 4, key: 'view.scaleQuarter' },
                ].map((item) =>
                  jsx('option', { value: String(item.value), children: `${t('view.scale')}: ${t(item.key)}` }, item.value),
                ),
              }),
              note === null ? null : jsx('span', { className: 'pve-vm-ok', children: note }),
            ],
          }),
        ],
      });
    }

    /**
     * Tab auto-open: when the agent touches a VM console the panel reveals itself —
     * if the owner asked for it with the `viewAutoOpen` setting.
     *
     * The first state read only remembers the mark: otherwise every page reload
     * would open the tab because of the agent's older work.
     * @param {object} ctx the client context.
     * @returns {() => void} stops watching.
     */
    function armAutoOpen(ctx) {
      const form = ctx.configForms.get(NAMESPACE);
      let primed = false;
      let seenAt = 0;
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        const values = form.getSnapshot()?.value ?? {};
        if (values.viewAutoOpen !== true) return;
        try {
          const response = await fetch(`${VIEW_BASE}/state`, { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (!response.ok) return;
          const state = await response.json();
          const at = Number(state?.last?.at ?? 0);
          if (!primed) {
            primed = true;
            seenAt = at;
            return;
          }
          if (at <= seenAt) return;
          seenAt = at;
          const sessionId = ctx.sidebarRight.mounted.getSnapshot();
          if (sessionId === undefined) return;
          ctx.sidebarRight.openTabIn(sessionId, TAB_KIND);
        } catch {
          // Network and response parsing are no reason to shout in the console: the
          // panel shows the error anyway once it is opened.
        }
      };
      const timer = setInterval(tick, AUTO_OPEN_POLL_MS);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
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
      // The observation panel is a second, independent contribution. Not every
      // composition has a right sidebar, so the services are declared through
      // ctx.inject: without them the settings card still works (see §4.4.1 of the
      // project AGENTS.md — never turn a service read into an undeclared, optional
      // dependency).
      // каждой композиции, поэтому сервисы объявлены через ctx.inject: без них
      // карточка настроек всё равно работает (см. §4.4.1 проектного AGENTS.md —
      // не превращать чтение сервиса в необязательную, но необъявленную зависимость).
      ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scoped) => {
        const disposers = [];
        const own = (dispose) => {
          if (typeof dispose === 'function') disposers.push(dispose);
        };

        own(
          scoped.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => translate()('tab.title'),
            guide: [
              {
                id: 'console',
                order: 55,
                title: () => translate()('tab.title'),
                description: () => translate()('tab.guide'),
              },
            ],
          }),
        );

        const injectPane = () => ({ ctx, form: ctx.configForms.get(NAMESPACE) });
        own(
          scoped.slots.inject('sidebar.right.pane.tab', () =>
            scoped.slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: LOCALE_NS, inject: injectPane },
              ConsolePane,
            ),
          ),
        );
        own(
          scoped.slots.inject('sidebar.right.pane.tab.title', () =>
            scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: LOCALE_NS }, ConsoleTitle),
          ),
        );

        // Автооткрытие — отдельный слой: он живёт и когда панель закрыта.
        const stopAutoOpen = armAutoOpen(ctx);
        return () => {
          stopAutoOpen();
          for (const dispose of disposers.reverse()) dispose();
        };
      });
    }

    exports.apply = apply;
    exports.inject = ['slots', 'locale', 'configForms'];
    return module.exports;
  },
});
