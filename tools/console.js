/**
 * Console tools: the screen frame and input over RFB.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { encodePng, cropRegion, downscaleBox } from '../lib/png.js';
import { encodeText, parseCombo } from '../lib/keys.js';
import { comboToSendkey, textToSendkeys } from '../lib/hmp.js';
import { planTyping } from '../lib/keys.js';
import { VmError } from '../lib/session.js';

const BUTTONS = ['left', 'middle', 'right'];

/** A description of one frame for the agent. */
function describeShot(meta) {
  const parts = [
    `VM ${meta.vmid}: frame ${meta.captureWidth}x${meta.captureHeight}`,
    meta.scale === 1 ? '(native resolution)' : `(screen ${meta.width}x${meta.height}, downscaled ${Math.round(1 / meta.scale)}x)`,
    meta.region ? `region x=${meta.region.x} y=${meta.region.y} ${meta.region.width}x${meta.region.height}` : null,
    `pointer (${meta.pointer.x}, ${meta.pointer.y})${meta.cursorDrawn ? ', drawn in frame' : ', not drawn in frame'}`,
    meta.blank ? 'FRAME NEARLY UNIFORM — the guest OS likely blanked the display or the screen is locked' : null,
    `${meta.bytes} bytes`,
  ];
  return parts.filter(Boolean).join('; ');
}

/**
 * Build the image: the full frame, a region crop, downscaling, PNG and attachment.
 */
async function capture(controller, attachments, params) {
  return controller.withConsole(params.vmid, async (client) => {
    const grab = async () => {
      client.requestUpdate({ incremental: false });
      await client.waitForUpdate({ timeoutMs: params.timeoutMs });
      return client.snapshot({ drawCursor: params.drawCursor !== false });
    };
    if (params.wake !== false) await client.wake({ settleMs: 400 });
    let frame = await grab();
    // A waking guest does not repaint the screen instantly: if the frame is still
    // uniform, give it time and request the frame a second time.
    if (looksBlank(frame) && params.wake !== false) {
      await sleep(1200);
      await client.wake({ settleMs: 600 });
      await sleep(600);
      frame = await grab();
    }
    const full = { width: frame.width, height: frame.height };
    let region = null;
    if (params.region) {
      const cropped = cropRegion(frame, params.region);
      region = { x: cropped.x, y: cropped.y, width: cropped.width, height: cropped.height };
      frame = { width: cropped.width, height: cropped.height, data: cropped.data };
    }
    const blank = looksBlank(frame);
    const factor = Math.max(1, Math.round(1 / (params.scale ?? 1)));
    const scaled = factor > 1 ? downscaleBox(frame, factor) : { ...frame, scale: 1 };
    const png = encodePng(scaled);
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: `vm-${params.vmid}-console.png` });
    return {
      vmid: params.vmid,
      width: full.width,
      height: full.height,
      captureWidth: scaled.width,
      captureHeight: scaled.height,
      scale: factor > 1 ? 1 / factor : 1,
      ...(region ? { region } : {}),
      pointer: { x: client.pointer.x, y: client.pointer.y },
      cursorDrawn: Boolean(client.cursor) && params.drawCursor !== false,
      blank,
      bytes: png.length,
      attachment: ref,
    };
  });
}

/** Image response: a text summary plus the frame itself. */
function shotOutput(meta, extraText) {
  return [
    { type: 'text', text: `${extraText ? `${extraText}\n` : ''}${describeShot(meta)}` },
    { type: 'image', attachment: meta.attachment },
  ];
}

/** Frame result schema (the same for every observing tool). */
const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    vmid: { type: 'number', required: true, description: 'VM id.' },
    width: { type: 'number', required: true, description: 'Width of the VM screen in pixels.' },
    height: { type: 'number', required: true, description: 'Height of the VM screen in pixels.' },
    captureWidth: { type: 'number', required: true, description: 'Width of the returned frame.' },
    captureHeight: { type: 'number', required: true, description: 'Height of the returned frame.' },
    scale: { type: 'number', required: true, description: 'Frame downscale factor (1 means native).' },
    region: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number', required: true },
        y: { type: 'number', required: true },
        width: { type: 'number', required: true },
        height: { type: 'number', required: true },
      },
    },
    pointer: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number', required: true, description: 'Pointer X on the VM screen.' },
        y: { type: 'number', required: true, description: 'Pointer Y on the VM screen.' },
      },
    },
    cursorDrawn: { type: 'boolean', required: true, description: 'Is the pointer drawn in the frame.' },
    blank: { type: 'boolean', description: 'The frame is nearly uniform (blanked display or lock screen).' },
    bytes: { type: 'number', required: true, description: 'PNG size in bytes.' },
    attachment: { type: 'json', required: true, description: 'Attachment reference holding the frame.' },
    actions: { type: 'array', description: 'Actions performed (for a batch).' },
    note: { type: 'string', description: 'A note, for example about a required reconnect.' },
  },
};

/** Text result schema for an action without observation. */
/** Result of reading the guest clipboard. */
const CLIPBOARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    vmid: { type: 'number', required: true, description: 'VM id.' },
    ok: { type: 'boolean', required: true, description: 'The read completed.' },
    text: { type: 'string', required: true, description: 'Clipboard text (an empty string means no text).' },
    chars: { type: 'number', required: true, description: 'Text length in characters.' },
  },
};

const PLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    vmid: { type: 'number', required: true, description: 'VM id.' },
    ok: { type: 'boolean', required: true, description: 'The action completed.' },
    pointer: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number', required: true },
        y: { type: 'number', required: true },
      },
    },
    actions: { type: 'array', description: 'Actions performed (for a batch).' },
    pointer: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number', required: true },
        y: { type: 'number', required: true },
      },
    },
  },
};

const REGION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number', required: true, description: 'Left edge of the region.' },
    y: { type: 'number', required: true, description: 'Top edge of the region.' },
    width: { type: 'number', required: true, description: 'Region width.' },
    height: { type: 'number', required: true, description: 'Region height.' },
  },
};

const OBSERVE_PARAMS = {
  observe: { type: 'boolean', description: 'Return a frame after the action (default true).' },
  wake: {
    type: 'boolean',
    description: 'Wake the session before the frame (Shift + pointer jitter); default yes, otherwise a blanked display gives a black frame.',
  },
  settleMs: { type: 'number', description: 'Pause before the frame, ms (default 500).' },
  scale: { type: 'number', description: 'Frame downscale when observing: 1 — native, 0.5 — by half.' },
  region: { ...REGION_SCHEMA, description: 'Frame region when observing.' },
};

/** Pause. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A nearly uniform frame: most often a blanked display or a black lock screen.
 * Checked with a coarse sample so that we do not scan a million pixels.
 */
function looksBlank(image) {
  const step = Math.max(4, Math.floor((image.width * image.height) / 4096)) * 4;
  let min = 255;
  let max = 0;
  for (let i = 0; i < image.data.length; i += step) {
    const value = image.data[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min <= 6;
}

/**
 * Input channel taken from the settings.
 * @param {object} settings snapshot of the plugin settings.
 * @returns {'auto'|'hmp'|'vnc'} the selected channel.
 */
function inputChannel(settings) {
  const channel = settings.inputChannel;
  return channel === 'hmp' || channel === 'vnc' ? channel : 'auto';
}

/**
 * Type text through the selected channel.
 *
 * `auto` — the `planTyping` plan: capitals via Caps Lock (HMP), the rest as
 * keysyms over RFB; this is the only path proven on a live Windows guest.
 * @param {object} controller VM controller.
 * @param {object} deps tool dependencies (settings is required).
 * @param {number} vmid VM id.
 * @param {string} text the text.
 * @returns {Promise<{channel:string, note:string}>} what was actually applied.
 */
async function typeTextVia(controller, deps, vmid, text) {
  const channel = inputChannel(deps.settings());
  if (channel === 'hmp') {
    const keys = textFor(text, true);
    const { count } = await controller.sendkeys(vmid, keys);
    return { channel, note: `sendkey, ${count} keys` };
  }
  if (channel === 'vnc') {
    const steps = textFor(text, false);
    await controller.withConsole(vmid, async (client) => {
      await client.typeSteps(steps);
    });
    return { channel, note: 'RFB keysym' };
  }
  let plan;
  try {
    plan = planTyping(text);
  } catch (error) {
    throw new VmError(`${error.message}. For non-ASCII use vm_type_text.`, 'NON_ASCII');
  }
  let caps = 0;
  await controller.withConsole(vmid, async (client) => {
    const outcome = await controller.typePlan(vmid, plan, client);
    caps = outcome.caps;
  });
  return { channel, note: `keysym + ${caps} Caps Lock toggles` };
}

/** Expand text for the selected channel, with a clear non-ASCII error. */
function textFor(text, sendkey) {
  try {
    return sendkey ? textToSendkeys(text) : encodeText(text);
  } catch (error) {
    throw new VmError(`${error.message}. For non-ASCII use vm_type_text.`, 'NON_ASCII');
  }
}

/** Apply one DSL action to the RFB client. */
async function applyAction(client, action, context) {
  const { vmid, controller, sendkey } = context;
  const kind = action.do;
  switch (kind) {
    case 'move':
      client.pointerEvent(action.x, action.y, 0);
      return `move(${action.x},${action.y})`;
    case 'click': {
      client.pointerEvent(action.x, action.y, 0);
      await sleep(60);
      await client.click({ button: action.button ?? 'left', count: action.count ?? 1 });
      return `click(${action.x},${action.y}${action.count && action.count > 1 ? ` x${action.count}` : ''})`;
    }
    case 'drag': {
      const from = action.from ?? { x: action.x, y: action.y };
      const to = action.to ?? { x: action.toX, y: action.toY };
      if (!from || !to || from.x === undefined || to.x === undefined) {
        throw new VmError('drag requires from and to (or x, y, toX, toY)', 'BAD_ARGS');
      }
      await client.drag(from, to, { button: action.button ?? 'left' });
      return `drag(${from.x},${from.y}→${to.x},${to.y})`;
    }
    case 'scroll':
      client.pointerEvent(action.x, action.y, 0);
      await client.scroll(action.delta ?? -3);
      return `scroll(${action.x},${action.y},${action.delta ?? -3})`;
    case 'type': {
      const text = action.text ?? '';
      if (sendkey === 'hmp') {
        const { count } = await controller.sendkeys(vmid, textFor(text, true));
        return `type(${JSON.stringify(text)}) — sendkey, ${count} keys`;
      }
      if (sendkey === 'vnc') {
        await client.typeSteps(textFor(text, false));
        return `type(${JSON.stringify(text)}) — RFB keysym`;
      }
      let plan;
      try {
        plan = planTyping(text);
      } catch (error) {
        throw new VmError(`${error.message}. For non-ASCII use vm_type_text.`, 'NON_ASCII');
      }
      const outcome = await controller.typePlan(vmid, plan, client);
      return `type(${JSON.stringify(text)}) — keysym + ${outcome.caps} Caps Lock`;
    }
    case 'key': {
      if (sendkey === 'hmp') {
        await controller.sendkeys(vmid, [comboToSendkey(action.combo ?? '')]);
        return `key(${action.combo}) — sendkey`;
      }
      await client.pressCombo(parseCombo(action.combo ?? ''));
      return `key(${action.combo})`;
    }
    case 'wait':
      await sleep(Math.max(0, Math.min(120000, action.ms ?? 500)));
      return `wait(${action.ms ?? 500}ms)`;
    default:
      throw new VmError(`unknown action "${kind}"`, 'BAD_ACTION');
  }
}

/**
 * Build the console tool definitions.
 * @param {{controller: object, attachments: object, settings: () => object}} deps
 * @returns {object[]} definitions for `ctx.tools.register`.
 */
export function consoleTools(deps) {
  const { controller, attachments } = deps;

  /** Observation after an action: a frame or a text response. */
  async function afterAction(vmid, label, params, actions) {
    const observe = params.observe !== false;
    if (!observe) {
      return { value: { vmid, ok: true, actions }, text: `${label} — done on VM ${vmid}` };
    }
    await sleep(Math.max(0, params.settleMs ?? 500));
    const meta = await capture(controller, attachments, {
      vmid,
      region: params.region,
      scale: params.scale,
      wake: params.wake,
      timeoutMs: deps.settings().consoleTimeoutMs,
    });
    return { value: { ...meta, actions }, text: `${label} — done` };
  }

  const observeOutput = {
    schema: { oneOf: [SHOT_SCHEMA, PLAIN_SCHEMA] },
    render: (args, value) => {
      if (value && value.attachment) {
        return [
          { type: 'text', text: `${(value.actions ?? []).join(' → ')}\n${describeShot(value)}`.trim() },
          { type: 'image', attachment: value.attachment },
        ];
      }
      return [{ type: 'text', text: `${(value?.actions ?? []).join(' → ')}\nVM ${value?.vmid}: done`.trim() }];
    },
  };

  const plainOutput = {
    schema: PLAIN_SCHEMA,
    render: (args, value) => [
      {
        type: 'text',
        text: `${(value?.actions ?? []).join(' → ') || 'ok'}\nVM ${value?.vmid}: pointer (${value?.pointer?.x ?? '?'}, ${value?.pointer?.y ?? '?'})`.trim(),
      },
    ],
  };

  return [
    {
      name: 'console_shot',
      description:
        'Screenshot of a Proxmox virtual machine from its VNC console. Returns the frame as an image. ' +
        'Works on any guest OS, even before the system has booted. For small text take the shot without ' +
        'downscaling; use region to zoom into part of the screen.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id (must be in allowVmids).' },
        region: { ...REGION_SCHEMA, description: 'Capture only this region of the screen (VM pixels).' },
        scale: { type: 'number', description: 'Frame downscale: 1 — native, 0.5 — half, 0.25 — a quarter.' },
        drawCursor: { type: 'boolean', description: 'Draw the pointer in the frame (default yes).' },
        wake: {
          type: 'boolean',
          description: 'Wake the session before the frame (Shift + pointer jitter); default yes, otherwise a blanked display gives a black frame.',
        },
      },
      output: { schema: SHOT_SCHEMA, render: (args, value) => shotOutput(value) },
      timeoutMs: 120000,
      async execute(args, exec) {
        return capture(controller, attachments, {
          vmid: args.vmid,
          region: args.region,
          scale: args.scale,
          drawCursor: args.drawCursor,
          wake: args.wake,
          timeoutMs: deps.settings().consoleTimeoutMs,
          signal: exec?.signal,
        });
      },
    },
    {
      name: 'console_move',
      description: 'Move the pointer in the VM console to (x, y) in VM screen pixels.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        x: { type: 'number', required: true, description: 'X in VM screen pixels.' },
        y: { type: 'number', required: true, description: 'Y in VM screen pixels.' },
        ...OBSERVE_PARAMS,
      },
      output: observeOutput,
      timeoutMs: 120000,
      async execute(args) {
        const label = `move(${args.x},${args.y})`;
        await controller.withConsole(args.vmid, async (client) => {
          client.pointerEvent(args.x, args.y, 0);
        });
        const outcome = await afterAction(args.vmid, label, args, [label]);
        return outcome.value;
      },
    },
    {
      name: 'console_click',
      description:
        'Click the mouse in the VM console at (x, y) in VM screen pixels. By default returns a frame after the click, ' +
        'so that the result is visible right away.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        x: { type: 'number', required: true, description: 'X in VM screen pixels.' },
        y: { type: 'number', required: true, description: 'Y in VM screen pixels.' },
        button: { type: 'string', enum: BUTTONS, description: 'Mouse button (default left).' },
        count: { type: 'number', description: 'Number of clicks: 2 — a double click.' },
        ...OBSERVE_PARAMS,
      },
      output: observeOutput,
      timeoutMs: 120000,
      async execute(args) {
        const label = `click(${args.x},${args.y}${args.count && args.count > 1 ? ` x${args.count}` : ''})`;
        await controller.withConsole(args.vmid, async (client) => {
          client.pointerEvent(args.x, args.y, 0);
          await sleep(60);
          await client.click({ button: args.button ?? 'left', count: args.count ?? 1 });
        });
        const outcome = await afterAction(args.vmid, label, args, [label]);
        return outcome.value;
      },
    },
    {
      name: 'console_drag',
      description: 'Drag the mouse in the VM console from one point to another — e.g. move a window or select a region.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        fromX: { type: 'number', required: true, description: 'Start X.' },
        fromY: { type: 'number', required: true, description: 'Start Y.' },
        toX: { type: 'number', required: true, description: 'End X.' },
        toY: { type: 'number', required: true, description: 'End Y.' },
        button: { type: 'string', enum: BUTTONS, description: 'Mouse button (default left).' },
        ...OBSERVE_PARAMS,
      },
      output: observeOutput,
      timeoutMs: 120000,
      async execute(args) {
        const label = `drag(${args.fromX},${args.fromY}→${args.toX},${args.toY})`;
        await controller.withConsole(args.vmid, async (client) => {
          await client.drag({ x: args.fromX, y: args.fromY }, { x: args.toX, y: args.toY }, { button: args.button ?? 'left' });
        });
        const outcome = await afterAction(args.vmid, label, args, [label]);
        return outcome.value;
      },
    },
    {
      name: 'console_scroll',
      description: 'Scroll the mouse wheel in the VM console at (x, y). A positive delta scrolls up, a negative one down.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        x: { type: 'number', required: true, description: 'X of the scroll point.' },
        y: { type: 'number', required: true, description: 'Y of the scroll point.' },
        delta: { type: 'number', required: true, description: 'Wheel steps: -3 — three down, 3 — up.' },
        ...OBSERVE_PARAMS,
      },
      output: observeOutput,
      timeoutMs: 120000,
      async execute(args) {
        const label = `scroll(${args.x},${args.y},${args.delta})`;
        await controller.withConsole(args.vmid, async (client) => {
          client.pointerEvent(args.x, args.y, 0);
          await client.scroll(args.delta);
        });
        const outcome = await afterAction(args.vmid, label, args, [label]);
        return outcome.value;
      },
    },
    {
      name: 'console_type',
      description:
        'Type text in the VM console. Printable ASCII only (letters, digits, punctuation, Enter as \\n): ' +
        'RFB transmits keysyms, not characters, so Cyrillic cannot be typed this way — use vm_type_text. ' +
        'Capitals are typed via Caps Lock (otherwise QEMU gets confused about the Shift state), so typing ' +
        'is not instant — about 0.1 s per character. The guest layout behaves as on a real keyboard: ' +
        'a Russian layout will not type Latin characters, switch it with console_key and `alt+shift`.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        text: { type: 'string', required: true, description: 'Text to type (printable ASCII).' },
        ...OBSERVE_PARAMS,
      },
      output: observeOutput,
      timeoutMs: 180000,
      async execute(args) {
        const label = `type(${JSON.stringify(args.text)})`;
        const applied = await typeTextVia(controller, deps, args.vmid, args.text);
        const outcome = await afterAction(args.vmid, `${label} — ${applied.note}`, args, [label]);
        return outcome.value;
      },
    },
    {
      name: 'console_key',
      description:
        'Press a key combination in the console: `enter`, `esc`, `tab`, `ctrl+alt+del`, `win+r`, `alt+f4`, ' +
        '`ctrl+shift+esc`, `f5`. Combinations of modifiers alone are supported — for example `alt+shift` ' +
        'switches the layout on the login screen (with a Russian layout Latin characters will not be typed).',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        combo: { type: 'string', required: true, description: 'Key combination, for example ctrl+alt+del.' },
        ...OBSERVE_PARAMS,
      },
      output: observeOutput,
      timeoutMs: 120000,
      async execute(args) {
        const label = `key(${args.combo})`;
        if (inputChannel(deps.settings()) === 'hmp') {
          await controller.sendkeys(args.vmid, [comboToSendkey(args.combo)]);
          const outcome = await afterAction(args.vmid, `${label} — sendkey`, args, [label]);
          return outcome.value;
        }
        const combo = parseCombo(args.combo);
        await controller.withConsole(args.vmid, async (client) => {
          await client.pressCombo(combo);
        });
        const outcome = await afterAction(args.vmid, label, args, [label]);
        return outcome.value;
      },
    },
    {
      name: 'console_paste',
      description:
        'Paste text into the VM via the clipboard: put the string into the guest clipboard ' +
        '(RFB ClientCutText) and press Ctrl+V. Handles any Unicode and does not depend on the ' +
        'layout or modifiers. Requires `vga: <type>,clipboard=vnc` on the VM and a SPICE agent ' +
        '(`spice-agent` / `vdservice`) running in the guest. Without the agent use vm_type_text.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        text: { type: 'string', required: true, description: 'Text to paste (any Unicode).' },
        submit: { type: 'boolean', description: 'Press Enter after pasting (for example, to run a command).' },
        ...OBSERVE_PARAMS,
      },
      output: observeOutput,
      timeoutMs: 120000,
      async execute(args) {
        const text = String(args.text ?? '');
        if (text.length === 0) throw new VmError('empty text', 'BAD_ARGS');
        await controller.withConsole(args.vmid, async (client) => {
          client.clientCutText(text);
          // The guest must have time to take the clipboard from QEMU, or Ctrl+V pastes the old content.
          await sleep(700);
          client.keyEvent(0xffe3, true);
          await sleep(60);
          await client.tap(0x76, { holdMs: 40, gapMs: 60 });
          client.keyEvent(0xffe3, false);
          if (args.submit === true) {
            await sleep(200);
            await client.tap(0xff0d);
          }
        });
        const label = `paste(${text.length} characters${args.submit === true ? ' + enter' : ''})`;
        const outcome = await afterAction(args.vmid, label, args, [label]);
        return outcome.value;
      },
    },
    {
      name: 'console_batch',
      description:
        'Run a chain of console actions in one call and return one frame at the end. Cheaper and faster ' +
        'than separate calls: use it when the sequence is already clear (click → type → Enter → pause).',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        actions: {
          type: 'array',
          required: true,
          description:
            'Actions in order: {do:"move",x,y} | {do:"click",x,y,button?,count?} | {do:"drag",from:{x,y},to:{x,y}} | ' +
            '{do:"scroll",x,y,delta} | {do:"type",text} | {do:"key",combo} | {do:"wait",ms}.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              do: { type: 'string', required: true, description: 'Action type.' },
              x: { type: 'number', description: 'X for move/click/scroll.' },
              y: { type: 'number', description: 'Y for move/click/scroll.' },
              button: { type: 'string', description: 'Mouse button.' },
              count: { type: 'number', description: 'Number of clicks.' },
              delta: { type: 'number', description: 'Wheel steps.' },
              text: { type: 'string', description: 'Text for type (printable ASCII).' },
              combo: { type: 'string', description: 'Key combination for key.' },
              ms: { type: 'number', description: 'Pause for wait.' },
            },
          },
        },
        ...OBSERVE_PARAMS,
      },
      output: observeOutput,
      timeoutMs: 300000,
      async execute(args) {
        const actions = Array.isArray(args.actions) ? args.actions : [];
        if (actions.length === 0) throw new VmError('empty action list', 'BAD_ACTION');
        const done = [];
        const context = { vmid: args.vmid, controller, sendkey: inputChannel(deps.settings()) };
        await controller.withConsole(args.vmid, async (client) => {
          for (const action of actions) done.push(await applyAction(client, action, context));
        });
        const outcome = await afterAction(args.vmid, 'batch', args, done);
        return outcome.value;
      },
    },
    {
      name: 'console_clipboard',
      description:
        'Read the guest text clipboard (the VNC extended clipboard). Requires `vga: <type>,clipboard=vnc` on the VM ' +
        'and a running SPICE agent in the guest. Handy for taking text out of the VM (an error message, a path, ' +
        'output) without OCR. An empty string means the clipboard is empty or holds no text.',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
        timeoutMs: { type: 'number', description: 'Timeout for the guest reply, ms (default 5000).' },
      },
      output: {
        schema: CLIPBOARD_SCHEMA,
        render: (args, value) => [
          {
            type: 'text',
            text:
              `VM ${value.vmid} clipboard: ${value.chars} chars\n` +
              (value.text.length > 0 ? value.text : '(empty — the clipboard holds no text)'),
          },
        ],
      },
      timeoutMs: 60000,
      async execute(args) {
        const timeoutMs = Math.max(500, Math.min(30000, Number(args.timeoutMs ?? 5000)));
        const text = await controller.withConsole(args.vmid, async (client) => client.readClipboard({ timeoutMs }));
        return { vmid: Number(args.vmid), ok: true, text, chars: [...text].length };
      },
    },
    {
      name: 'console_release',
      description: 'Close the VM console session (kill switch: frees the ssh process and QEMU connection).',
      parameters: {
        vmid: { type: 'number', required: true, description: 'VM id.' },
      },
      output: plainOutput,
      async execute(args) {
        controller.assertAllowed(args.vmid, 'console');
        const closed = controller.close(args.vmid);
        return { vmid: Number(args.vmid), ok: true, actions: [closed ? 'session closed' : 'no session'], pointer: { x: 0, y: 0 } };
      },
    },
  ].map((options) => defineTool(options));
}
