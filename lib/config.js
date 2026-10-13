/**
 * Plugin configuration.
 *
 * In 0.2.x the settings form is not written by hand: the `settings` service finds the plugin by
 * the id of its entry in the patch layer and builds the form from the exported `Config` schema.
 * That is why every field must be `.volatile()` — otherwise the service refuses to write the
 * field ("Config field … is not volatile"), and `apply` receives not values but
 * live references with `.get()`.
 */
import z from '@deepseek-ai/schemastery';

/** Text input script inside a Linux guest (used by `vm_type_text`). */
export const DEFAULT_GUEST_TYPE_COMMAND = [
  'set -e',
  // `$(...)` strips trailing newlines, and without them the text cannot be
  // "submitted" with Enter: `vm_type_text` with a trailing \"\\n\" silently typed
  // the line and left the prompt waiting.
  'text=$(printf %s "$1" | base64 -d; printf X)',
  'text=${text%X}',
  'uid=""; home=""; disp=""; xauth=""',
  'for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk \'{print $1}\'); do',
  '  [ "$(loginctl show-session "$s" -p Active --value 2>/dev/null)" = "yes" ] || continue',
  '  uid=$(loginctl show-session "$s" -p User --value 2>/dev/null) || continue',
  '  home=$(getent passwd "$uid" | cut -d: -f6)',
  '  disp=$(loginctl show-session "$s" -p Display --value 2>/dev/null)',
  '  [ -n "$disp" ] && break',
  'done',
  '[ -n "$disp" ] || disp=":0"',
  '[ -n "$uid" ] || uid=$(id -u)',
  // XAUTHORITY. GDM (RedOS 8, RHEL) keeps it in /run/user/<uid>/gdm/Xauthority,
  // and ~/.Xauthority may not exist at all — xdotool then talked to X with no
  // authorization whatsoever, got "No protocol specified" and typed nothing
  // (found during acceptance on 2026-10-13, RedOS 8 + MATE + GDM).
  'if [ -n "$home" ] && [ -f "$home/.Xauthority" ]; then xauth="$home/.Xauthority"',
  'elif [ -f "/run/user/$uid/gdm/Xauthority" ]; then xauth="/run/user/$uid/gdm/Xauthority"',
  'else xauth=$(ls -1 /run/user/$uid/*/Xauthority /run/user/$uid/xauth* 2>/dev/null | head -1)',
  'fi',
  'run() { if [ -n "$xauth" ]; then XAUTHORITY="$xauth" DISPLAY="$disp" "$@"; else DISPLAY="$disp" "$@"; fi; }',
  'if command -v xdotool >/dev/null 2>&1; then run xdotool type --delay 12 --clearmodifiers -- "$text"; exit 0; fi',
  'if command -v wtype >/dev/null 2>&1; then',
  '  wd=$(loginctl show-session "$(loginctl list-sessions --no-legend | awk \'{print $1}\' | head -1)" -p Type --value 2>/dev/null)',
  '  if [ "$wd" = "wayland" ]; then XDG_RUNTIME_DIR="/run/user/$uid" WAYLAND_DISPLAY=wayland-0 wtype -- "$text"; exit 0; fi',
  'fi',
  'echo "neither xdotool nor wtype worked: a graphical session and one of these packages are required" >&2',
  'exit 3',
].join('\n');

/** Schema keys: `snapshot` reads the live values by them. */
export const CONFIG_KEYS = [
  'sshHost',
  'sshUser',
  'sshPort',
  'sshKeyPath',
  'sshConfigFile',
  'sshExtraOptions',
  'allowVmids',
  'enableConsole',
  'enableGuest',
  'consoleTimeoutMs',
  'sessionIdleMs',
  'guestTimeoutMs',
  'guestTypeCommand',
];

/** Settings schema: the id of the entry in `cordis.patch.yml` must match `pve-vm`. */
export const Config = z.object({
  sshHost: z
    .string()
    .default('proxmox')
    .description('Proxmox VE node: an alias from ~/.ssh/config or an address (for example 10.0.0.10).')
    .volatile(),
  sshUser: z.string().default('root').description('ssh user on the node.').volatile(),
  sshPort: z.number().step(1).min(1).max(65535).default(22).description('ssh port.').volatile(),
  sshKeyPath: z
    .string()
    .default('')
    .description('Path to the private SSH key. Empty — the default SSH keys.')
    .volatile(),
  sshConfigFile: z
    .string()
    .default('')
    .description('Custom ssh-config (equivalent to `ssh -F`). Empty — the standard ~/.ssh/config.')
    .volatile(),
  sshExtraOptions: z
    .array(z.string())
    .default([])
    .description('Extra ssh `-o` options, one per element.')
    .volatile(),
  allowVmids: z
    .array(z.number().step(1).min(1))
    .default([])
    .description('VMs the plugin is allowed to work with. An empty list forbids everything.')
    .volatile(),
  enableConsole: z.boolean().default(true).description('Enable the console (VNC) tools.').volatile(),
  enableGuest: z.boolean().default(true).description('Enable the guest agent tools.').volatile(),
  inputChannel: z
    .union(['auto', 'hmp', 'vnc'])
    .default('auto')
    .description(
      'Text input channel: auto — the reliable plan (Caps Lock for capitals through `qm monitor`, ' +
        'the rest as keysym over RFB; verified on `Pa55w0rd!`), hmp — everything through QEMU sendkey ' +
        '(faster, but it loses modifiers), vnc — RFB keysym only (upper case breaks).',
    )
    .volatile(),
  sendkeyDelayMs: z
    .number()
    .step(5)
    .min(5)
    .max(500)
    .default(80)
    .description(
      'Delay between keys in the hmp channel, ms. 80 ms is the verified pace (2026-10-13): at 40 ms ' +
        'QEMU sometimes lost the modifier (`shift-a` produced `a`).',
    )
    .volatile(),
  consoleTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .default(20000)
    .description('Console operation timeout, ms.')
    .volatile(),
  sessionIdleMs: z
    .number()
    .step(1)
    .min(10000)
    .default(300000)
    .description('Idle milliseconds after which the console session is closed.')
    .volatile(),
  guestTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .default(60000)
    .description('Guest agent command timeout, ms.')
    .volatile(),
  guestTypeCommand: z
    .string()
    .default(DEFAULT_GUEST_TYPE_COMMAND)
    .description(
      'Script for typing non-ASCII text in a Linux guest: takes the base64 text as its first argument ($1).',
    )
    .volatile(),
});

/**
 * Take the live schema values into a plain object.
 * @param {Record<string, {get?: () => unknown}>} live the config that `apply` received.
 * @returns {Record<string, unknown>} a slice of the settings at call time.
 */
export function snapshot(live) {
  const section = {};
  for (const key of CONFIG_KEYS) {
    const field = live?.[key];
    const value = typeof field?.get === 'function' ? field.get() : field;
    if (value !== undefined) section[key] = value;
  }
  return section;
}

/** Expand a leading `~` in a path. */
function expandHome(path) {
  if (typeof path !== 'string' || path.length === 0) return '';
  if (path === '~') return process.env.HOME ?? path;
  if (path.startsWith('~/')) return `${process.env.HOME ?? '~'}${path.slice(1)}`;
  return path;
}

/**
 * Reduce the settings slice to a shape convenient for the tools.
 * @param {Record<string, unknown>} section the result of {@link snapshot}.
 * @returns {{ssh:object,allowVmids:number[],enableConsole:boolean,enableGuest:boolean,consoleTimeoutMs:number,sessionIdleMs:number,guestTimeoutMs:number,guestTypeCommand:string}}
 */
export function resolveSettings(section) {
  const allowVmids = Array.isArray(section.allowVmids)
    ? section.allowVmids.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
    : [];
  return {
    ssh: {
      host: String(section.sshHost ?? 'proxmox'),
      user: String(section.sshUser ?? 'root'),
      port: Number(section.sshPort ?? 22),
      keyPath: expandHome(section.sshKeyPath),
      sshConfig: expandHome(section.sshConfigFile),
      extraOptions: Array.isArray(section.sshExtraOptions) ? section.sshExtraOptions.map(String) : [],
    },
    allowVmids,
    enableConsole: section.enableConsole !== false,
    enableGuest: section.enableGuest !== false,
    inputChannel: ['vnc', 'hmp'].includes(section.inputChannel) ? section.inputChannel : 'auto',
    sendkeyDelayMs: Math.max(5, Number(section.sendkeyDelayMs ?? 80)),
    consoleTimeoutMs: Number(section.consoleTimeoutMs ?? 20000),
    sessionIdleMs: Number(section.sessionIdleMs ?? 300000),
    guestTimeoutMs: Number(section.guestTimeoutMs ?? 60000),
    guestTypeCommand: typeof section.guestTypeCommand === 'string' ? section.guestTypeCommand : DEFAULT_GUEST_TYPE_COMMAND,
  };
}
