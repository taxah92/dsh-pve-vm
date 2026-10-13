/**
 * RFB (VNC) client over an arbitrary duplex stream.
 *
 * The stream comes from `qm vncproxy` over ssh: the child process stdin/stdout is
 * raw RFB, with no TCP ports, TLS or websocket. Exactly the messages computer-use
 * needs are implemented: frame (Raw/CopyRect), cursor shape, resolution change,
 * pointer and keyboard.
 *
 * The pixel format is requested once at the start: 32bpp, depth 24,
 * little-endian, R in the least significant byte → in memory the frame is stored as R,G,B,X.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { inflateSync } from 'node:zlib';

/** Rectangle encodings and pseudo-encodings. */
/** Extended clipboard flags (QEMU `ui/vnc.h`). */
export const CLIPBOARD_FLAG = {
  TEXT: 1 << 0,
  RTF: 1 << 1,
  HTML: 1 << 2,
  DIB: 1 << 3,
  FILES: 1 << 4,
  CAPS: 1 << 24,
  REQUEST: 1 << 25,
  PEEK: 1 << 26,
  NOTIFY: 1 << 27,
  PROVIDE: 1 << 28,
};

export const ENCODING = {
  /**
   * Extended clipboard (QEMU `VNC_ENCODING_CLIPBOARD_EXT` = 0xc0a1e5ce).
   * In the protocol this is a signed 32-bit number, so we coerce it with `| 0`.
   */
  CLIPBOARD_EXT: 0xc0a1e5ce | 0,
  RAW: 0,
  COPY_RECT: 1,
  HEXTILE: 5,
  DESKTOP_SIZE: -223,
  CURSOR: -239,
  QEMU_EXTENDED_KEY: -258,
  EXTENDED_DESKTOP_SIZE: -308,
};

const BTN = { left: 1, middle: 2, right: 4, wheelUp: 8, wheelDown: 16, wheelLeft: 32, wheelRight: 64 };

/** Protocol error class: distinguishes "the server said no" from a transport failure. */
export class RfbError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RfbError';
    this.code = code;
  }
}

/** Reader of exact byte chunks from a Readable with a shared deadline. */
class ByteReader {
  constructor(stream, timeoutMs) {
    this.stream = stream;
    this.timeoutMs = timeoutMs;
    this.chunks = [];
    this.length = 0;
    this.bytesRead = 0;
    this.waiter = null;
    this.failure = null;
    this.ended = false;
    stream.on('data', (chunk) => {
      this.chunks.push(chunk);
      this.length += chunk.length;
      this.#wake();
    });
    stream.on('end', () => {
      this.ended = true;
      this.#wake();
    });
    stream.on('error', (error) => {
      this.failure = error;
      this.#wake();
    });
  }

  #wake() {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve();
    }
  }

  #take(n) {
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      const need = n - offset;
      if (head.length <= need) {
        head.copy(out, offset);
        offset += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, offset, 0, need);
        this.chunks[0] = head.subarray(need);
        offset += need;
      }
    }
    this.length -= n;
    this.bytesRead += n;
    return out;
  }

  /**
   * Read exactly `n` bytes.
   * @param {number} n number of bytes.
   * @param {number} [timeoutMs] timeout override.
   * @returns {Promise<Buffer>}
   */
  async exact(n, timeoutMs = this.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.length < n) {
      if (this.failure) throw this.failure;
      if (this.ended) throw new RfbError('VNC stream closed on the node side', 'EOF');
      const left = deadline - Date.now();
      if (left <= 0) throw new RfbError(`timeout waiting for ${n} RFB bytes (got ${this.length})`, 'TIMEOUT');
      await new Promise((resolve) => {
        this.waiter = resolve;
        setTimeout(() => {
          if (this.waiter === resolve) {
            this.waiter = null;
            resolve();
          }
        }, Math.min(left, 250));
      });
    }
    return this.#take(n);
  }
}

/** VNC authentication response: DES over a 16-byte challenge with the key bits reversed. */
function vncAuthResponse(password, challenge) {
  const raw = Buffer.alloc(8);
  Buffer.from(String(password), 'binary').copy(raw, 0, 0, 8);
  const key = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    let byte = raw[i];
    let reversed = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      reversed = (reversed << 1) | (byte & 1);
      byte >>= 1;
    }
    key[i] = reversed;
  }
  // des-ede3 with three identical keys = single DES: des-ecb is unavailable in OpenSSL 3.
  const cipher = crypto.createCipheriv('des-ede3', Buffer.concat([key, key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

/** RFB client: one instance per VM (one connection to its console). */
export class RfbClient extends EventEmitter {
  /**
   * @param {{input:import('node:stream').Readable,output:import('node:stream').Writable,timeoutMs?:number,
   *   extendedClipboard?:boolean}} options
   *   input — bytes from the server, output — bytes to the server; `extendedClipboard`
   *   enables the extended clipboard (needed to *read* the guest clipboard).
   */
  constructor(options) {
    super();
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.reader = new ByteReader(options.input, this.timeoutMs);
    this.output = options.output;
    this.width = 0;
    this.height = 0;
    this.name = '';
    this.pixelFormat = null;
    /** @type {Buffer|null} RGBA frame. */
    this.framebuffer = null;
    /** @type {?{width:number,height:number,hotspotX:number,hotspotY:number,data:Buffer,mask:Buffer}} */
    this.cursor = null;
    this.pointer = { x: 0, y: 0, mask: 0 };
    this.clipboardText = null;
    /** Extended clipboard: without it QEMU sends only legacy text. */
    this.extendedClipboard = options.extendedClipboard !== false;
    /** Flags supported by the server (from the CAPS message). */
    this.clipboardCaps = null;
    this.bell = 0;
    this.bytesIn = 0;
  }

  /**
   * Handshake up to and including ServerInit.
   * @param {{password?:string,shared?:boolean}} [options] VNC authentication password.
   * @returns {Promise<void>}
   */
  async connect(options = {}) {
    const version = (await this.reader.exact(12)).toString('latin1');
    if (!version.startsWith('RFB ')) throw new RfbError(`not RFB: ${JSON.stringify(version)}`, 'PROTOCOL');
    const serverVersion = version.slice(4, 11);
    const [major, minor] = serverVersion.split('.').map((part) => Number.parseInt(part, 10));
    const useVersion = major > 3 || (major === 3 && minor >= 8) ? '003.008' : serverVersion;
    this.write(Buffer.from(`RFB ${useVersion}\n`, 'latin1'));
    const modern = useVersion === '003.008';

    let securityType;
    if (modern) {
      const count = (await this.reader.exact(1))[0];
      if (count === 0) {
        const reason = await this.reader.exact(4);
        throw new RfbError(`the server refused the connection (code ${reason.readUInt32BE(0)})`, 'REFUSED');
      }
      const types = [...(await this.reader.exact(count))];
      if (types.includes(2)) securityType = 2;
      else if (types.includes(1)) securityType = 1;
      else throw new RfbError(`no supported authentication type: ${types.join(',')}`, 'SECURITY');
      this.write(Buffer.from([securityType]));
    } else {
      securityType = (await this.reader.exact(4)).readUInt32BE(0);
      if (securityType === 0) {
        const reason = await this.reader.exact(4);
        throw new RfbError(`the server refused the connection (code ${reason.readUInt32BE(0)})`, 'REFUSED');
      }
    }

    if (securityType === 2) {
      if (!options.password) throw new RfbError('the server requires a VNC password, none given', 'SECURITY');
      const challenge = await this.reader.exact(16);
      this.write(vncAuthResponse(options.password, challenge));
    } else if (securityType !== 1) {
      throw new RfbError(`unsupported authentication type ${securityType}`, 'SECURITY');
    }

    if (securityType === 2 || modern) {
      const result = (await this.reader.exact(4)).readUInt32BE(0);
      if (result !== 0) throw new RfbError('VNC authentication rejected (wrong password)', 'AUTH');
    }

    this.write(Buffer.from([options.shared === false ? 0 : 1]));
    const header = await this.reader.exact(24);
    this.width = header.readUInt16BE(0);
    this.height = header.readUInt16BE(2);
    this.pixelFormat = {
      bpp: header[4],
      depth: header[5],
      bigEndian: header[6] === 1,
      trueColor: header[7] === 1,
      redMax: header.readUInt16BE(8),
      greenMax: header.readUInt16BE(10),
      blueMax: header.readUInt16BE(12),
      redShift: header[14],
      greenShift: header[15],
      blueShift: header[16],
    };
    const nameLength = header.readUInt32BE(20);
    this.name = nameLength > 0 ? (await this.reader.exact(nameLength)).toString('utf8') : '';
    // Alpha is 255: QEMU keeps zero in the fourth byte of a pixel, and without this
    // the frame would go to PNG fully transparent.
    this.framebuffer = Buffer.alloc(this.width * this.height * 4, 0xff);
    this.setPixelFormat();
    const encodings = [ENCODING.RAW, ENCODING.COPY_RECT, ENCODING.CURSOR, ENCODING.DESKTOP_SIZE];
    if (this.extendedClipboard) encodings.push(ENCODING.CLIPBOARD_EXT);
    this.setEncodings(encodings);
  }

  /** @param {Buffer} buffer write bytes to the stream towards the server. */
  write(buffer) {
    this.output.write(buffer);
  }

  /** Ask the server for the 32bpp/depth 24/LE format with R in the least significant byte. */
  setPixelFormat() {
    const message = Buffer.alloc(20);
    message[0] = 0;
    message[4] = 32;
    message[5] = 24;
    message[6] = 0;
    message[7] = 1;
    message.writeUInt16BE(255, 8);
    message.writeUInt16BE(255, 10);
    message.writeUInt16BE(255, 12);
    message[14] = 0;
    message[15] = 8;
    message[16] = 16;
    this.write(message);
  }

  /** @param {number[]} encodings list of encodings. */
  setEncodings(encodings) {
    const message = Buffer.alloc(4 + encodings.length * 4);
    message[0] = 2;
    message.writeUInt16BE(encodings.length, 2);
    encodings.forEach((encoding, index) => message.writeInt32BE(encoding, 4 + index * 4));
    this.write(message);
  }

  /**
   * Request a region update.
   * @param {{incremental?:boolean,x?:number,y?:number,width?:number,height?:number}} [request]
   */
  requestUpdate(request = {}) {
    const message = Buffer.alloc(10);
    message[0] = 3;
    message[1] = request.incremental === false ? 0 : 1;
    message.writeUInt16BE(request.x ?? 0, 2);
    message.writeUInt16BE(request.y ?? 0, 4);
    message.writeUInt16BE(request.width ?? this.width, 6);
    message.writeUInt16BE(request.height ?? this.height, 8);
    this.write(message);
  }

  /**
   * Pointer event.
   * @param {number} x coordinate.
   * @param {number} y coordinate.
   * @param {number} mask button bitmask.
   */
  pointerEvent(x, y, mask) {
    const message = Buffer.alloc(6);
    message[0] = 5;
    message[1] = mask & 0xff;
    message.writeUInt16BE(Math.max(0, Math.min(this.width - 1, Math.round(x))), 2);
    message.writeUInt16BE(Math.max(0, Math.min(this.height - 1, Math.round(y))), 4);
    this.write(message);
    this.pointer = { x: Math.round(x), y: Math.round(y), mask };
  }

  /**
   * Key event.
   * @param {number} keysym X11 keysym.
   * @param {boolean} down press (true) or release (false).
   */
  keyEvent(keysym, down) {
    const message = Buffer.alloc(8);
    message[0] = 4;
    message[1] = down ? 1 : 0;
    message.writeUInt32BE(keysym >>> 0, 4);
    this.write(message);
  }

  /**
   * Put text into the guest clipboard (only delivered if vdagent runs in the guest).
   * @param {string} text text.
   */
  clientCutText(text) {
    const payload = Buffer.from(text, 'utf8');
    const message = Buffer.alloc(8);
    message[0] = 6;
    message.writeUInt32BE(payload.length, 4);
    this.write(Buffer.concat([message, payload]));
  }

  /**
   * Read messages until the next FramebufferUpdate.
   *
   * `idleOk` is what the observation panel needs: it asks for an incremental frame
   * often, and "nothing changed" is a normal answer from QEMU (it simply stays
   * silent). Silence at a message boundary is safe — the current framebuffer is
   * returned. A timeout in the middle of a message means half a frame was lost,
   * which is a real error and the session has to be recreated.
   * @param {{timeoutMs?:number, idleOk?:boolean}} [options] wait timeout and tolerance for silence.
   * @returns {Promise<{rectangles:number, bytes:number, resized:boolean, cursor:boolean, bell:boolean, idle?:boolean}>}
   */
  async waitForUpdate(options = {}) {
    const deadline = Date.now() + (options.timeoutMs ?? this.timeoutMs);
    const idleOk = options.idleOk === true;
    let rectangles = 0;
    let cursorUpdated = false;
    let bell = false;
    let resized = false;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) {
        if (idleOk) return { rectangles: 0, bytes: 0, resized: false, cursor: false, bell: false, idle: true };
        throw new RfbError('timeout waiting for an RFB frame', 'TIMEOUT');
      }
      let first;
      try {
        first = await this.reader.exact(1, left);
      } catch (error) {
        if (idleOk && error?.code === 'TIMEOUT') {
          return { rectangles: 0, bytes: 0, resized: false, cursor: false, bell: false, idle: true };
        }
        throw error;
      }
      const type = first[0];
      if (type === 0) {
        const header = await this.reader.exact(3, left);
        const count = header.readUInt16BE(1);
        for (let i = 0; i < count; i += 1) {
          const outcome = await this.#readRectangle(deadline);
          if (outcome === 'cursor') cursorUpdated = true;
          else if (outcome === 'resize') resized = true;
          else rectangles += 1;
        }
        return { rectangles, bytes: this.bytesIn, resized, cursor: cursorUpdated, bell };
      }
      if (type === 1) {
        const header = await this.reader.exact(5, left);
        const count = header.readUInt16BE(3);
        await this.reader.exact(count * 6, left);
        continue;
      }
      if (type === 2) {
        bell = true;
        continue;
      }
      if (type === 3) {
        const header = await this.reader.exact(7, left);
        // The length is signed: a negative value means the extended clipboard
        // (QEMU `vnc_client_cut_text_ext`), where the payload is
        // "flags (u32) + a zlib stream for PROVIDE".
        const rawLength = header.readInt32BE(3);
        if (rawLength >= 0) {
          const text = rawLength > 0 ? await this.reader.exact(rawLength, left) : Buffer.alloc(0);
          this.clipboardText = text.toString('utf8');
          this.emit('clipboard', this.clipboardText);
          continue;
        }
        const size = -rawLength;
        const payload = size > 0 ? await this.reader.exact(size, left) : Buffer.alloc(0);
        this.#handleExtendedClipboard(payload);
        continue;
      }
      throw new RfbError(`unknown RFB message type ${type}`, 'PROTOCOL');
    }
  }

  /**
   * Parse an extended clipboard message.
   * @param {Buffer} payload flags (u32) and, for PROVIDE, a zlib stream.
   */
  #handleExtendedClipboard(payload) {
    if (payload.length < 4) return;
    const flags = payload.readUInt32BE(0);
    if ((flags & CLIPBOARD_FLAG.CAPS) !== 0) {
      this.clipboardCaps = flags;
      this.emit('clipboard-caps', flags);
      return;
    }
    if ((flags & CLIPBOARD_FLAG.NOTIFY) !== 0) {
      this.emit('clipboard-notify', flags);
      return;
    }
    if ((flags & CLIPBOARD_FLAG.PROVIDE) !== 0 && (flags & CLIPBOARD_FLAG.TEXT) !== 0) {
      try {
        // Inside the zlib stream: the text size (u32), then the UTF-8 text itself.
        const inflated = inflateSync(payload.subarray(4));
        if (inflated.length < 4) return;
        const size = inflated.readUInt32BE(0);
        const text = inflated.subarray(4, 4 + size).toString('utf8');
        this.clipboardText = text;
        this.emit('clipboard', text);
      } catch (error) {
        this.emit('clipboard-error', error);
      }
      return;
    }
    if ((flags & CLIPBOARD_FLAG.REQUEST) !== 0) {
      // The server asks for our clipboard — we have none of our own, so there is nothing to reply with.
      this.emit('clipboard-request', flags);
    }
  }

  /**
   * Ask the server for the guest clipboard text.
   * Extended form of `ClientCutText`: a negative length and flags.
   */
  requestClipboard() {
    if (!this.extendedClipboard) throw new RfbError('the extended clipboard is not enabled', 'CLIPBOARD');
    const message = Buffer.alloc(12);
    message[0] = 6;
    message.writeInt32BE(-4, 4);
    message.writeUInt32BE(CLIPBOARD_FLAG.REQUEST | CLIPBOARD_FLAG.TEXT, 8);
    this.write(message);
  }

  /**
   * Read the guest text clipboard.
   *
   * Requires `vga: <type>,clipboard=vnc` on the VM and a live SPICE agent in the guest.
   * An empty string means the clipboard is empty or holds no text.
   * @param {{timeoutMs?:number}} [options] how long to wait for PROVIDE.
   * @returns {Promise<string>} clipboard text.
   */
  async readClipboard(options = {}) {
    const timeoutMs = options.timeoutMs ?? 5000;
    this.clipboardText = null;
    this.requestClipboard();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (typeof this.clipboardText === 'string') return this.clipboardText;
      try {
        await this.waitForUpdate({ timeoutMs: Math.min(700, Math.max(50, deadline - Date.now())) });
      } catch (error) {
        if (error?.code !== 'TIMEOUT') throw error;
      }
    }
    return typeof this.clipboardText === 'string' ? this.clipboardText : '';
  }

  async #readRectangle(deadline) {
    const header = await this.reader.exact(12, Math.max(1, deadline - Date.now()));
    const x = header.readUInt16BE(0);
    const y = header.readUInt16BE(2);
    const width = header.readUInt16BE(4);
    const height = header.readUInt16BE(6);
    const encoding = header.readInt32BE(8);
    this.emit('rect', { x, y, width, height, encoding, received: this.reader.bytesRead });

    if (encoding === ENCODING.RAW) {
      const bytes = await this.reader.exact(width * height * 4, Math.max(1, deadline - Date.now()));
      this.bytesIn += bytes.length;
      this.#blitRaw(x, y, width, height, bytes);
      return 'rect';
    }
    if (encoding === ENCODING.COPY_RECT) {
      const source = await this.reader.exact(4, Math.max(1, deadline - Date.now()));
      this.#blitCopy(source.readUInt16BE(0), source.readUInt16BE(2), x, y, width, height);
      return 'rect';
    }
    if (encoding === ENCODING.CURSOR) {
      const pixels = await this.reader.exact(width * height * 4, Math.max(1, deadline - Date.now()));
      const maskStride = Math.ceil(width / 8);
      const mask = width > 0 && height > 0 ? await this.reader.exact(maskStride * height, Math.max(1, deadline - Date.now())) : Buffer.alloc(0);
      this.cursor = width > 0 && height > 0 ? { width, height, hotspotX: x, hotspotY: y, data: pixels, mask } : null;
      this.emit('cursor', this.cursor);
      return 'cursor';
    }
    if (encoding === ENCODING.DESKTOP_SIZE || encoding === ENCODING.EXTENDED_DESKTOP_SIZE) {
      if (encoding === ENCODING.EXTENDED_DESKTOP_SIZE) await this.reader.exact(4, Math.max(1, deadline - Date.now()));
      this.#resize(width, height);
      return 'resize';
    }
    throw new RfbError(`unsupported rectangle encoding ${encoding}`, 'ENCODING');
  }

  #blitRaw(x, y, width, height, bytes) {
    const stride = this.width * 4;
    for (let row = 0; row < height; row += 1) {
      const target = (y + row) * stride + x * 4;
      bytes.copy(this.framebuffer, target, row * width * 4, row * width * 4 + width * 4);
      for (let column = 0; column < width; column += 1) this.framebuffer[target + column * 4 + 3] = 255;
    }
  }

  #blitCopy(sourceX, sourceY, x, y, width, height) {
    const stride = this.width * 4;
    for (let row = 0; row < height; row += 1) {
      const from = (sourceY + row) * stride + sourceX * 4;
      this.framebuffer.copy(this.framebuffer, (y + row) * stride + x * 4, from, from + width * 4);
    }
  }

  #resize(width, height) {
    if (width === this.width && height === this.height) return;
    const next = Buffer.alloc(width * height * 4, 0xff);
    const rows = Math.min(height, this.height);
    const columns = Math.min(width, this.width);
    for (let row = 0; row < rows; row += 1) {
      this.framebuffer.copy(next, row * width * 4, row * this.width * 4, row * this.width * 4 + columns * 4);
    }
    this.framebuffer = next;
    this.width = width;
    this.height = height;
    this.emit('resize', { width, height });
  }

  /**
   * RGBA frame with the cursor drawn in (RFB does not put the cursor into the framebuffer).
   * @param {{drawCursor?:boolean}} [options] `drawCursor: false` — without the cursor.
   * @returns {{width:number,height:number,data:Buffer}}
   */
  snapshot(options = {}) {
    const data = Buffer.from(this.framebuffer);
    if (options.drawCursor !== false && this.cursor) this.#drawCursor(data);
    return { width: this.width, height: this.height, data };
  }

  #drawCursor(target) {
    const { width, height, hotspotX, hotspotY, data, mask } = this.cursor;
    const baseX = this.pointer.x - hotspotX;
    const baseY = this.pointer.y - hotspotY;
    const maskStride = Math.ceil(width / 8);
    for (let row = 0; row < height; row += 1) {
      const y = baseY + row;
      if (y < 0 || y >= this.height) continue;
      for (let column = 0; column < width; column += 1) {
        const x = baseX + column;
        if (x < 0 || x >= this.width) continue;
        const opaque = (mask[row * maskStride + (column >> 3)] >> (7 - (column & 7))) & 1;
        if (!opaque) continue;
        const from = (row * width + column) * 4;
        const to = (y * this.width + x) * 4;
        target[to] = data[from];
        target[to + 1] = data[from + 1];
        target[to + 2] = data[from + 2];
        target[to + 3] = 255;
      }
    }
  }

  /**
   * Press and release mouse buttons at the current point.
   * @param {{button?:'left'|'right'|'middle', count?:number}} [options] button and click count.
   */
  async click(options = {}) {
    const bit = BTN[options.button ?? 'left'] ?? BTN.left;
    const count = Math.max(1, options.count ?? 1);
    for (let i = 0; i < count; i += 1) {
      this.pointerEvent(this.pointer.x, this.pointer.y, this.pointer.mask | bit);
      await new Promise((resolve) => setTimeout(resolve, 40));
      this.pointerEvent(this.pointer.x, this.pointer.y, this.pointer.mask & ~bit);
      if (i + 1 < count) await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  /**
   * Wheel scroll at the current point.
   * @param {number} delta positive — up, negative — down.
   */
  async scroll(delta) {
    const bit = delta > 0 ? BTN.wheelUp : BTN.wheelDown;
    const steps = Math.max(1, Math.min(20, Math.abs(Math.round(delta))));
    for (let i = 0; i < steps; i += 1) {
      this.pointerEvent(this.pointer.x, this.pointer.y, this.pointer.mask | bit);
      await new Promise((resolve) => setTimeout(resolve, 30));
      this.pointerEvent(this.pointer.x, this.pointer.y, this.pointer.mask & ~bit);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }

  /**
   * Mouse drag.
   * @param {{x:number,y:number}} from start.
   * @param {{x:number,y:number}} to end.
   * @param {{button?:'left'|'right'|'middle',steps?:number}} [options] button and step count.
   */
  async drag(from, to, options = {}) {
    const bit = BTN[options.button ?? 'left'] ?? BTN.left;
    const steps = Math.max(2, Math.min(40, options.steps ?? 12));
    this.pointerEvent(from.x, from.y, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    this.pointerEvent(from.x, from.y, bit);
    for (let step = 1; step <= steps; step += 1) {
      const x = from.x + ((to.x - from.x) * step) / steps;
      const y = from.y + ((to.y - from.y) * step) / steps;
      this.pointerEvent(x, y, bit);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.pointerEvent(to.x, to.y, 0);
  }

  /**
   * Wake the guest session: Windows/Linux blank the display on idle, and the server
   * returns a fully black frame. Shift and a few pixels of pointer jiggle are enough —
   * no actual button press happens.
   * @param {{settleMs?:number}} [options] pause after waking.
   */
  async wake(options = {}) {
    this.keyEvent(0xffe1, true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    this.keyEvent(0xffe1, false);
    const from = { x: Math.max(0, this.pointer.x - 2), y: Math.max(0, this.pointer.y - 2) };
    const to = {
      x: Math.min(Math.max(0, this.width - 1), from.x + 4),
      y: Math.min(Math.max(0, this.height - 1), from.y + 4),
    };
    this.pointerEvent(from.x, from.y, 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    this.pointerEvent(to.x, to.y, 0);
    await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 150));
  }

  /**
   * Type text (ASCII) via keysyms.
   * @param {Array<{keysym:number,shift:boolean}>} steps steps from `encodeText`.
   */
  async typeSteps(steps) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // The pace was tuned live on 2026-10-13 (tools/input-probe.mjs, input-probe2.mjs):
    // fast typing lost modifiers. The key detail is the PAUSE BEFORE Shift:
    // without it `7!` produced `71`, and `xxXX` produced `xxxX` (the guest had no time
    // to process the previous key and dropped the modifier). At 45-60 ms everything lines up.
    for (const step of steps) {
      if (step.shift) {
        await wait(60);
        this.keyEvent(0xffe1, true);
        await wait(45);
      }
      this.keyEvent(step.keysym, true);
      await wait(35);
      this.keyEvent(step.keysym, false);
      if (step.shift) {
        await wait(35);
        this.keyEvent(0xffe1, false);
      }
      await wait(45);
    }
  }

  /**
   * A single key press without modifiers, with "hold — release" pauses.
   * @param {number} keysym keysym of the key.
   * @param {{holdMs?:number, gapMs?:number}} [options] timings, ms.
   */
  async tap(keysym, options = {}) {
    const holdMs = options.holdMs ?? 45;
    const gapMs = options.gapMs ?? 45;
    this.keyEvent(keysym, true);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    this.keyEvent(keysym, false);
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }

  /**
   * Key press with Shift.
   *
   * The pause BEFORE the modifier is mandatory: if Shift arrives right after the
   * previous key, the guest applies the stale state to it and the character loses the
   * shift (verified: `7!` → `71`, cured by a 60 ms pause).
   * @param {number} keysym keysym of the base (unshifted) key.
   * @param {{preMs?:number, holdMs?:number, gapMs?:number}} [options] timings, ms.
   */
  async tapShifted(keysym, options = {}) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(options.preMs ?? 60);
    this.keyEvent(0xffe1, true);
    await wait(options.modifierMs ?? 45);
    this.keyEvent(keysym, true);
    await wait(options.holdMs ?? 35);
    this.keyEvent(keysym, false);
    await wait(options.gapMs ?? 35);
    this.keyEvent(0xffe1, false);
    await wait(options.gapMs ?? 45);
  }

  /**
   * Press a key combination.
   * @param {{modifiers:number[],key:number}} combo parsed combination.
   */
  async pressCombo(combo) {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    /** Release everything pressed, in reverse order. */
    const release = async (keys) => {
      for (const keysym of [...keys].reverse()) {
        this.keyEvent(keysym, false);
        await wait(20);
      }
    };
    if (combo.key === -1 || combo.key === undefined) {
      // A combination of modifiers only (Alt+Shift, Win+Space): press them together.
      for (const modifier of combo.modifiers) {
        this.keyEvent(modifier, true);
        await wait(40);
      }
      await wait(60);
      await release(combo.modifiers);
      return;
    }
    for (const modifier of combo.modifiers) {
      this.keyEvent(modifier, true);
      // The same reason as in typeSteps: the modifier must have time to arrive.
      await wait(30);
    }
    this.keyEvent(combo.key, true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    this.keyEvent(combo.key, false);
    for (const modifier of [...combo.modifiers].reverse()) this.keyEvent(modifier, false);
  }
}
