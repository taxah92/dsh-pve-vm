/**
 * The live VM screen for the observation panel.
 *
 * Why a separate module. The agent's tools capture a frame on demand and hand it
 * back as an attachment; a panel needs something else: often, cheaply, and without
 * attachments — "what is on screen right now". The frame comes from **the same**
 * RFB session the tools use (`VmController.withConsole`), therefore:
 *
 *   • no second VNC session to the VM appears, and the `qm vncproxy` password is
 *     not reset under the agent's feet;
 *   • there is still exactly one session queue — the panel and the agent never
 *     tear the stream for each other;
 *   • a session the panel holds open is not reaped by the idle reaper (every
 *     capture refreshes `lastUsed`).
 *
 * Frames are requested incrementally: when the screen did not change QEMU stays
 * silent and the panel gets the current framebuffer from the client's memory (see
 * `idleOk` in `RfbClient.waitForUpdate`).
 */
import { encodePng, downscaleBox, looksBlank } from './png.js';

/** Lower bound on waiting for QEMU: below it we simply cannot read the answer. */
const MIN_WAIT_MS = 120;
/**
 * Upper bound on waiting. This is exactly how long the panel holds the session
 * queue when the screen does not change (QEMU stays silent on an incremental
 * request) — and therefore how long the agent waits for its own operation.
 * 250 ms is enough: QEMU hands over changed regions right after the request, and
 * anything that happens later is picked up by the next frame.
 */
const MAX_WAIT_MS = 250;
/**
 * How long to wait for the **first** frame of a session. On QXL/SPICE guests
 * QEMU first sends a "cursor only" update and the full frame in the next
 * message; 250 ms is not enough for that, and the panel showed a white screen
 * (verified on VM 115 2026-10-23). Waiting for a real frame for up to 1.5 s
 * happens once per session, so the queue delay is acceptable.
 */
const FIRST_FRAME_WAIT_MS = 1500;
/** zlib level for panel frames: speed over size, the channel is loopback. */
const PNG_LEVEL = 3;
/** Allowed resolution divisors (1 — native). */
const DIVISORS = [1, 2, 3, 4];

/**
 * How long to wait for a frame at the panel's pace.
 * @param {number} fps frames per second from the settings.
 * @returns {number} wait timeout, ms.
 */
function waitForFps(fps) {
  const interval = 1000 / Math.max(1, fps);
  return Math.max(MIN_WAIT_MS, Math.min(MAX_WAIT_MS, Math.round(interval - 50)));
}

/**
 * One VM's screen as the agent sees it.
 */
export class ConsoleView {
  /**
   * @param {{controller: object, settings: () => object}} deps the VM controller and live settings.
   */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, Promise<object>>} captures already running: two clients do not queue twice. */
    this.pending = new Map();
  }

  /** State for the panel: what is allowed, what is alive, whom to follow. */
  state() {
    const settings = this.deps.settings();
    const last = this.deps.controller.lastConsoleUse();
    return {
      allowed: settings.allowVmids,
      consoleEnabled: settings.enableConsole,
      sessions: this.deps.controller.listSessions(),
      last: last ? { vmid: last.vmid, at: last.at } : null,
      view: settings.view,
    };
  }

  /**
   * A frame of the VM screen as PNG.
   * @param {number} vmid VM id.
   * @param {{scale?:number, cursor?:boolean}} [options] resolution divisor and whether to draw the cursor.
   * @returns {Promise<{png:Buffer, meta:object}>} the PNG and its metadata.
   */
  frame(vmid, options = {}) {
    const settings = this.deps.settings();
    const id = this.deps.controller.assertAllowed(vmid, 'console');
    const divisor = DIVISORS.includes(Number(options.scale)) ? Number(options.scale) : settings.view.scale;
    const drawCursor = options.cursor !== false;
    const key = `${id}:${divisor}:${drawCursor ? 1 : 0}`;
    const running = this.pending.get(key);
    if (running !== undefined) return running;
    const task = this.#capture(id, divisor, drawCursor, waitForFps(settings.view.fps)).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, task);
    return task;
  }

  /**
   * Close the VM console session (the panel's "disconnect" button).
   * @param {number} vmid VM id.
   * @returns {boolean} true when a session existed and was closed.
   */
  release(vmid) {
    return this.deps.controller.close(vmid);
  }

  /**
   * Capture a frame with exclusive access to the console.
   * @param {number} vmid VM id.
   * @param {number} divisor resolution divisor.
   * @param {boolean} drawCursor whether to draw the cursor.
   * @param {number} waitMs how long to wait for the incremental answer.
   * @returns {Promise<{png:Buffer, meta:object}>}
   */
  async #capture(vmid, divisor, drawCursor, waitMs) {
    // `mark: false` — watching is not agent work: otherwise the panel would move
    // the "whom to follow" mark on every frame.
    return this.deps.controller.withConsole(
      vmid,
      async (client, session) => {
        // The first frame of a session is requested in full: a fresh client has no
        // "changed" regions yet, and an incremental request could stay silent.
        // The first frame is awaited as a real frame (`waitForFrame`), not as "any
        // update": on QXL/SPICE VMs a "cursor only" update arrives first, and the
        // panel showed a white screen (verified on VM 115 2026-10-23).
        const firstFrame = client.bytesIn === 0;
        client.requestUpdate({ incremental: !firstFrame });
        if (firstFrame) {
          await client.waitForFrame({ timeoutMs: Math.max(waitMs, FIRST_FRAME_WAIT_MS), idleOk: true });
        } else {
          await client.waitForUpdate({ timeoutMs: waitMs, idleOk: true });
        }
        const frame = client.snapshot({ drawCursor });
        const scaled = divisor > 1 ? downscaleBox(frame, divisor) : { ...frame, scale: 1 };
        const png = encodePng(scaled, { level: PNG_LEVEL });
        return {
          png,
          meta: {
            vmid,
            width: frame.width,
            height: frame.height,
            captureWidth: scaled.width,
            captureHeight: scaled.height,
            scale: divisor,
            pointerX: client.pointer.x,
            pointerY: client.pointer.y,
            cursorDrawn: Boolean(client.cursor) && drawCursor,
            blank: looksBlank(frame),
            bytes: png.length,
            sessionAlive: session.alive !== false,
          },
        };
      },
      { mark: false },
    );
  }
}
