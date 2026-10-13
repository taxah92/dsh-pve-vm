/**
 * Input through the HMP `sendkey` command (QEMU monitor).
 *
 * Why a separate channel: over RFB we send a **keysym**, and QEMU expands it
 * through its own keymap — and does so differently for letters and for shift
 * symbols (verified 2026-10-13: a literal keysym produced `A`, but `1` instead
 * of `!`, while Shift+keysym produced `a` instead of `A`). `sendkey` works one
 * level lower: QEMU presses the keycode itself and holds the modifiers, so
 * `shift-a` is exactly `A` and `shift-1` is exactly `!`.
 *
 * A side benefit: the path does not depend on the guest agent and works on the
 * login screen (RFB keysyms work there too, but with the caveats above).
 *
 * The price: root ssh to the node and a running VM are required; the guest
 * layout is applied as with a real keyboard (on the Russian layout `sendkey a`
 * gives the Cyrillic «ф»).
 */

/** Unshifted characters → QEMU key names (QKeyCode). */
const PLAIN_KEYS = new Map([
  [' ', 'spc'],
  ['-', 'minus'],
  ['=', 'equal'],
  ['[', 'bracket_left'],
  [']', 'bracket_right'],
  ['\\', 'backslash'],
  [';', 'semicolon'],
  ["'", 'apostrophe'],
  ['`', 'grave_accent'],
  [',', 'comma'],
  ['.', 'dot'],
  ['/', 'slash'],
  ['\n', 'ret'],
  ['\r', 'ret'],
  ['\t', 'tab'],
]);

/** Characters typed with Shift on the US layout → the base key. */
const SHIFTED_KEYS = new Map([
  ['~', 'grave_accent'],
  ['!', '1'],
  ['@', '2'],
  ['#', '3'],
  ['$', '4'],
  ['%', '5'],
  ['^', '6'],
  ['&', '7'],
  ['*', '8'],
  ['(', '9'],
  [')', '0'],
  ['_', 'minus'],
  ['+', 'equal'],
  ['{', 'bracket_left'],
  ['}', 'bracket_right'],
  ['|', 'backslash'],
  [':', 'semicolon'],
  ['"', 'apostrophe'],
  ['<', 'comma'],
  ['>', 'dot'],
  ['?', 'slash'],
]);

/** Key names spelled differently in HMP than in our combinations. */
const KEY_ALIASES = new Map([
  ['enter', 'ret'],
  ['return', 'ret'],
  ['escape', 'esc'],
  ['space', 'spc'],
  ['backspace', 'backspace'],
  ['delete', 'delete'],
  ['del', 'delete'],
  ['insert', 'insert'],
  ['ins', 'insert'],
  ['pageup', 'pgup'],
  ['pagedown', 'pgdn'],
  ['printscreen', 'print'],
  ['prtsc', 'print'],
  ['capslock', 'caps_lock'],
  ['scrolllock', 'scroll_lock'],
  ['menu', 'menu'],
  ['up', 'up'],
  ['down', 'down'],
  ['left', 'left'],
  ['right', 'right'],
  ['home', 'home'],
  ['end', 'end'],
  ['tab', 'tab'],
]);

/** Modifiers: name in a combination → name in HMP. */
const MODIFIER_NAMES = new Map([
  ['ctrl', 'ctrl'],
  ['control', 'ctrl'],
  ['shift', 'shift'],
  ['alt', 'alt'],
  ['altgr', 'alt_r'],
  ['meta', 'meta_l'],
  ['super', 'meta_l'],
  ['win', 'meta_l'],
  ['windows', 'meta_l'],
  ['cmd', 'meta_l'],
]);

/**
 * The QEMU key name for a single character.
 * @param {string} char one printable ASCII character, or \n / \t.
 * @returns {{name:string, shift:boolean}|null} the key name, or null if the character is unsupported.
 */
export function charToKey(char) {
  if (PLAIN_KEYS.has(char)) return { name: PLAIN_KEYS.get(char), shift: false };
  if (SHIFTED_KEYS.has(char)) return { name: SHIFTED_KEYS.get(char), shift: true };
  const code = char.codePointAt(0);
  if (char >= 'a' && char <= 'z') return { name: char, shift: false };
  if (char >= 'A' && char <= 'Z') return { name: char.toLowerCase(), shift: true };
  if (char >= '0' && char <= '9') return { name: char, shift: false };
  if (code === 0x20) return { name: 'spc', shift: false };
  return null;
}

/**
 * Expand text into a sequence of HMP expressions (`shift-a`, `spc`, …).
 * @param {string} text text (printable ASCII).
 * @returns {string[]} one element per character.
 * @throws {Error} if an unsupported character is encountered.
 */
export function textToSendkeys(text) {
  const keys = [];
  for (const char of String(text)) {
    const mapped = charToKey(char);
    if (mapped === null) {
      const code = char.codePointAt(0);
      throw new Error(
        `character «${char}» (U+${code.toString(16).toUpperCase().padStart(4, '0')}) is not supported by the sendkey channel (printable ASCII)`,
      );
    }
    keys.push(mapped.shift ? `shift-${mapped.name}` : mapped.name);
  }
  return keys;
}

/**
 * Turn a combination (`ctrl+alt+del`, `win+r`) into an HMP expression.
 * @param {string} combo key combination string.
 * @returns {string} for example `ctrl-alt-delete`.
 * @throws {Error} if the key is not recognised.
 */
export function comboToSendkey(combo) {
  const parts = String(combo)
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error('empty key combination');
  const names = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIER_NAMES.has(lower)) {
      names.push(MODIFIER_NAMES.get(lower));
      continue;
    }
    if (KEY_ALIASES.has(lower)) {
      names.push(KEY_ALIASES.get(lower));
      continue;
    }
    if (/^f([1-9]|1[0-2])$/.test(lower)) {
      names.push(lower);
      continue;
    }
    const mapped = charToKey(part.length === 1 ? part : lower);
    if (mapped === null) throw new Error(`unknown key «${part}»`);
    names.push(mapped.shift ? `shift-${mapped.name}` : mapped.name);
  }
  return names.join('-');
}

/**
 * Build the command for the node: a single `qm monitor` into which `sendkey`
 * lines are written with pauses. The pause lets the guest keep up with parsing
 * the input (otherwise a long string loses characters in the keyboard buffer).
 * @param {number|string} vmid VM id.
 * @param {string[]} keys sendkey expressions.
 * @param {{delayMs?:number, timeoutSec?:number}} [options] pause between keys and the overall timeout.
 * @returns {string} command for the remote shell.
 */
export function sendkeysCommand(vmid, keys, options = {}) {
  const delaySec = Math.max(0.005, (options.delayMs ?? 30) / 1000);
  const timeoutSec = options.timeoutSec ?? Math.max(30, Math.ceil(keys.length * delaySec) + 30);
  const list = keys.join('\n');
  return [
    `paced() { while IFS= read -r key; do printf 'sendkey %s\\n' "$key"; sleep ${delaySec}; done; }`,
    `paced <<'DSH_SENDKEYS' | timeout ${timeoutSec} /usr/sbin/qm monitor ${Number(vmid)} >/dev/null 2>&1`,
    list,
    'DSH_SENDKEYS',
  ].join('\n');
}
