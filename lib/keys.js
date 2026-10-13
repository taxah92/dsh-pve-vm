/**
 * X11 keysyms and the keyboard layout for RFB KeyEvent.
 *
 * RFB transmits a keysym, not a character: the server (QEMU) translates the
 * keysym into a keycode through its own keymap. So "typing a character" is
 * either a direct keysym (ASCII) or the Shift + base keysym pair for shifted
 * characters.
 */

/** Special keys: name in a combo → keysym. */
export const SPECIAL_KEYS = {
  enter: 0xff0d,
  return: 0xff0d,
  tab: 0xff09,
  escape: 0xff1b,
  esc: 0xff1b,
  backspace: 0xff08,
  delete: 0xffff,
  del: 0xffff,
  insert: 0xff63,
  ins: 0xff63,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pgup: 0xff55,
  pagedown: 0xff56,
  pgdn: 0xff56,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  space: 0x20,
  capslock: 0xffe5,
  printscreen: 0xff61,
  prtsc: 0xff61,
  scrolllock: 0xff14,
  pause: 0xff13,
  menu: 0xff67,
  f1: 0xffbe,
  f2: 0xffbf,
  f3: 0xffc0,
  f4: 0xffc1,
  f5: 0xffc2,
  f6: 0xffc3,
  f7: 0xffc4,
  f8: 0xffc5,
  f9: 0xffc6,
  f10: 0xffc7,
  f11: 0xffc8,
  f12: 0xffc9,
};

/** Modifiers: name in a combo → keysym. */
export const MODIFIER_KEYS = {
  ctrl: 0xffe3,
  control: 0xffe3,
  shift: 0xffe1,
  alt: 0xffe9,
  meta: 0xffe7,
  super: 0xffeb,
  win: 0xffeb,
  windows: 0xffeb,
  cmd: 0xffeb,
  altgr: 0xffea,
};

/**
 * Characters typed with Shift on the US layout: they need the base keysym AND
 * our own Shift event — QEMU does not expand them itself (verified: a literal
 * `!` produced `1`).
 */
const SHIFTED_CHARS = new Map([
  ['~', '`'],
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
  ['_', '-'],
  ['+', '='],
  ['{', '['],
  ['}', ']'],
  ['|', '\\'],
  [':', ';'],
  ['"', "'"],
  ['<', ','],
  ['>', '.'],
  ['?', '/'],
]);

/**
 * Parse a key name or a single character into a keysym.
 * @param {string} token name (`enter`, `f5`) or character (`a`, `7`).
 * @returns {number} keysym, or -1 if the name is unknown.
 */
export function keySymFor(token) {
  const lower = token.toLowerCase();
  if (Object.hasOwn(SPECIAL_KEYS, lower)) return SPECIAL_KEYS[lower];
  if (token.length === 1) {
    const code = token.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) return code;
  }
  return -1;
}

/**
 * Parse a combo such as `ctrl+alt+del`, `win+r`, `shift+F5`.
 * @param {string} combo key combination string.
 * @returns {{modifiers:number[], key:number, raw:string}} keysyms of the modifiers and the key.
 * @throws {Error} if the key or a modifier is unknown.
 */
export function parseCombo(combo) {
  const parts = String(combo)
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error('empty key combination');
  const modifiers = [];
  let key = -1;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (Object.hasOwn(MODIFIER_KEYS, lower)) {
      modifiers.push(MODIFIER_KEYS[lower]);
      continue;
    }
    const sym = keySymFor(part);
    if (sym === -1) throw new Error(`unknown key «${part}»`);
    if (key !== -1) throw new Error(`more than one key in the combination «${combo}»`);
    key = sym;
  }
  // A combination of modifiers only is a legitimate case: that is how the
  // layout (Alt+Shift) and the language (Win+Space) are switched. Then key stays -1.

  return { modifiers, key, raw: combo };
}

/**
 * Expand text into a sequence of keysym presses.
 *
 * The key detail, verified live on QEMU 9.2 (Proxmox) 2026-10-13: what must be
 * sent is the **keysym of the character itself** — `A` as 0x41, `!` as 0x21 —
 * and Shift must NOT be touched. QEMU expands a keysym through the shift column
 * of its own keymap, while a `Shift_L` event (0xffe1) sent separately does not
 * reach the guest as a modifier: with «Shift + 0x61» Notepad produced `a`
 * instead of `A`.
 *
 * Only printable ASCII is supported: Cyrillic requires another channel
 * (the clipboard or input inside the guest).
 * @param {string} text text to type.
 * @returns {Array<{keysym:number, shift:boolean}>} one element per character.
 * @throws {Error} if a character outside printable ASCII is encountered.
 */
export function encodeText(text) {
  const steps = [];
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code === 0x0a || code === 0x0d) {
      steps.push({ keysym: SPECIAL_KEYS.enter, shift: false });
      continue;
    }
    if (code === 0x09) {
      steps.push({ keysym: SPECIAL_KEYS.tab, shift: false });
      continue;
    }
    if (SHIFTED_CHARS.has(char)) {
      // A shifted character: base keysym + our own Shift event (QEMU does not
      // expand shift for `!` itself — a literal 0x21 produced `1`).
      steps.push({ keysym: SHIFTED_CHARS.get(char).codePointAt(0), shift: true });
      continue;
    }
    if (code >= 0x20 && code <= 0x7e) {
      // Letters, digits and unshifted characters — a literal keysym. An
      // uppercase letter goes as its own keysym (0x41) WITHOUT Shift: QEMU
      // expands it itself, while Shift+0x61 produced a lowercase one (verified 2026-10-13).
      steps.push({ keysym: code, shift: false });
      continue;
    }
    throw new Error(
      `character «${char}» (U+${code.toString(16).toUpperCase().padStart(4, '0')}) is not printable ASCII; ` +
        'non-ASCII requires the guest agent channel or the clipboard',
    );
  }
  return steps;
}

/** Characters typed with Shift on the US layout. */
const SHIFT_SYMBOLS = new Set([...'~!@#$%^&*()_+{}|:"<>?']);
/** Unshifted characters and the space. */
const PLAIN_SYMBOLS = new Set([...' -=[\\];\'`,./']);

/**
 * A reliable typing plan: avoid Shift entirely wherever possible.
 *
 * Derived from the probes of 2026-10-13 (tools/input-probe*.mjs). In short:
 *  * uppercase letters go through **Caps Lock** (HMP `sendkey caps_lock`) rather
 *    than through Shift: for an uppercase literal keysym QEMU emulates Shift
 *    itself, and after our shift events that emulation breaks (`xxXX` → `xxxX`);
 *  * shift symbols (`!@#%`) are the only place where Shift is needed; they get a
 *    pause before the modifier (otherwise `7!` produces `71`).
 *
 * @param {string} text text (printable ASCII).
 * @returns {Array<{op:'tap'|'shiftTap'|'caps', keysym?:number}>} operations in order.
 * @throws {Error} if a character outside printable ASCII is encountered.
 */
export function planTyping(text) {
  const ops = [];
  const chars = [...String(text)];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char >= 'A' && char <= 'Z') {
      let run = '';
      while (index < chars.length && chars[index] >= 'A' && chars[index] <= 'Z') {
        run += chars[index].toLowerCase();
        index += 1;
      }
      index -= 1;
      ops.push({ op: 'caps' });
      for (const letter of run) ops.push({ op: 'tap', keysym: letter.codePointAt(0) });
      ops.push({ op: 'caps' });
      continue;
    }
    if (char === '\n' || char === '\r') {
      ops.push({ op: 'tap', keysym: SPECIAL_KEYS.enter });
      continue;
    }
    if (char === '\t') {
      ops.push({ op: 'tap', keysym: SPECIAL_KEYS.tab });
      continue;
    }
    if (SHIFT_SYMBOLS.has(char)) {
      ops.push({ op: 'shiftTap', keysym: char.toLowerCase().codePointAt(0) });
      continue;
    }
    if (PLAIN_SYMBOLS.has(char) || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) {
      ops.push({ op: 'tap', keysym: char.codePointAt(0) });
      continue;
    }
    throw new Error(
      `character «${char}» (U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}) is not printable ASCII; ` +
        'non-ASCII requires the guest agent channel or the clipboard',
    );
  }
  return ops;
}
