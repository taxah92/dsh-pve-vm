# dsh-pve-vm

**Proxmox VE VM control for [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness): see a VM's screen and click in its console over VNC, plus commands, files and typed text through the QEMU guest agent.**

Almost every computer-use plugin drives the desktop the agent itself runs on — and therefore needs
X11 or Wayland, a screenshot tool and an input injector on that host. This plugin does something
different: it drives **the console of a virtual machine on a Proxmox VE node**, over one ssh
connection. The host can be a headless server, a Wayland desktop or a laptop in another country;
the guest can be Windows, Linux with any GUI, or a machine that has not booted yet.

```
agent ──► plugin ──► ssh ──► node: qm vncproxy ──► unix socket /var/run/qemu-server/<vmid>.vnc
                      └────► node: qm guest exec ──► qemu-guest-agent inside the VM
```

## What you get

* **Pixels** — `console_shot` returns the VM screen as an inline image (with `region` and `scale`
  to keep the token cost sane), and mouse/keyboard tools operate in VM screen coordinates: move,
  click, double click, drag, wheel, type, key combinations, and a batch runner that performs a
  chain of actions and returns a single frame at the end.
* **Commands** — `vm_exec`, `vm_file_read`, `vm_file_write`, `vm_status` through the QEMU guest
  agent. Deterministic and cheap: use pixels only where a GUI really is in the way.
* **Reliable input** — uppercase goes through Caps Lock (`qm monitor` → HMP `sendkey`), shifted
  symbols through RFB keysyms with a settle delay. This is what makes typing a password on the
  Windows login screen work instead of producing `xxXX` → `xxxX`.
* **Unicode text** — a Windows guest gets a scheduled task in the logged-in user's session
  (`SendKeys`), a Linux guest gets `xdotool`/`wtype` through the guest agent. Layout and
  modifiers stop mattering.
* **Clipboard** — `console_paste` writes UTF-8 text into the guest clipboard over RFB and presses
  Ctrl+V; `console_clipboard` reads the guest clipboard back, so text can leave the VM without OCR.
* **A settings card** in the web UI (English, Russian and Chinese labels), backed by the profile patch
  layer.
* **A live screen panel** — the “VM screen” tab in the right sidebar shows the frames the agent
  sees, taken from the very same VNC session, while the agent works. It follows the agent's VM
  automatically or stays on the VM you pick by hand. Watching only: the panel never clicks or types.
* **Zero runtime dependencies** — RFB, DES authentication, keysym tables and PNG encoding are
  implemented in this package on top of `node:crypto` and `node:zlib`. There is nothing to install
  on the host, and nothing to install on the node either.

Verified against `pve-manager 8.4.21` with Windows 11 / Windows Server 2025 and Linux guests, on
DeepSeek Harness `0.2.0-rc.2`.

## Requirements

| What | Why |
|---|---|
| DeepSeek Harness **≥ 0.2.0-rc.2** | The plugin uses the 0.2.x plugin contract (`defineTool`, `ctx.tools`, `ctx.subprocess`, `ctx.attachments`, the `computerUse` slot, client-side `configForms`). It does not load on 0.1.x. |
| Node.js **≥ 22** | The harness runtime. |
| A **Proxmox VE** node with the `qm` CLI | `/usr/sbin/qm vncproxy`, `qm guest exec`, `qm monitor`. Containers (LXC) are not supported. |
| **SSH access to that node as `root`** (or an account that may run `qm`) | `qm` needs root on the node. Key-based access is expected (`BatchMode`, no password prompts). |
| **`AcceptEnv LC_*` in the node's `sshd_config`** | The VNC password is handed to `qm` as the `LC_PVE_TICKET` environment variable via `SendEnv`, so it never appears in `ps`. Without `AcceptEnv`, ssh silently drops it and the console cannot authenticate. |
| Host key already accepted | Connections run with `BatchMode=yes`; an unknown host key fails. Run `ssh <node>` once by hand, or add `StrictHostKeyChecking=accept-new` to `sshExtraOptions`. |
| `qemu-guest-agent` **inside the guest** (optional) | Only the `vm_*` tools need it. Console tools work without any agent at all. |

## Install

```bash
# 1. Add the bundle
dsh plugin --profile web add github:taxah92/dsh-pve-vm

# 2. Make sure the bundle is enabled in the profile: dsh.profile.bundles must list "dsh-pve-vm"
#    (the plugin manager / market toggle does the same thing)

# 3. Restart the harness:  the host half of a plugin is loaded once per process
```

The plugin adds one row to the profile patch layer:

```yaml
- id: pve-vm
  name: dsh-pve-vm
```

The row id `pve-vm` **is** the settings namespace — do not rename it, or the settings card and the
patch layer will stop finding each other.

## Configure

Settings ▸ Plugins ▸ **Proxmox VE** in the web UI. Everything is written into the profile patch
layer, and the same values can be edited there by hand:

```yaml
- id: pve-vm
  name: dsh-pve-vm
  config:
    sshHost: proxmox            # alias from ~/.ssh/config, or an address
    sshUser: root
    sshPort: 22
    sshKeyPath: ''              # empty — default keys
    sshConfigFile: ''           # like `ssh -F`
    sshExtraOptions: []         # extra -o options, one per item
    allowVmids: [100, 101]      # VMs the plugin may touch; empty list forbids everything
    enableConsole: true
    enableGuest: true
    inputChannel: auto          # auto | hmp | vnc
    sendkeyDelayMs: 80
    consoleTimeoutMs: 20000
    sessionIdleMs: 300000
    guestTimeoutMs: 60000
    guestTypeCommand: ''        # script for typing non-ASCII text into a Linux guest
    viewAutoOpen: false         # open the "VM screen" tab by itself when the agent touches a console
    viewFollowAgent: true       # the panel follows the VM the agent works with
    viewFps: 2                  # frame pace in the panel, 1–4
    viewScale: 2                # frame resolution divisor: 1 native, 2 half, 4 quarter
```

**First run checklist**

1. `allowVmids` is empty by default — **nothing is allowed until you list a VM id**. This is the
   only gate the plugin has.
2. `ssh <alias> 'qm status <vmid>'` should work from the host without a password prompt.
3. `ssh <alias> sshd -T | grep -i acceptenv` must include `LC_*` (see Requirements).
4. Call `vm_status` — it reports whether the VM is allowed, whether the guest agent answers, which
   guest OS was detected, and whether a console session is open.

## Tools

### Console (VNC)

| Tool | Parameters | What it does |
|---|---|---|
| `console_shot` | `vmid`, `region?`, `scale?`, `drawCursor?`, `wake?` | Frame as an inline image. `scale` 1 / 0.5 / 0.25, `region` in VM pixels. Nearly uniform frames are flagged as `blank` (a blanked display or a locked screen). |
| `console_move` | `vmid`, `x`, `y`, `observe?`, `wake?`, `settleMs?`, `scale?`, `region?` | Move the pointer. |
| `console_click` | `vmid`, `x`, `y`, `button?`, `count?`, `observe?`, … | Click (2 = double click); returns a frame by default. |
| `console_drag` | `vmid`, `fromX`, `fromY`, `toX`, `toY`, `button?`, … | Drag — move a window, select a region. |
| `console_scroll` | `vmid`, `x`, `y`, `delta`, … | Wheel: positive scrolls up, negative down. |
| `console_type` | `vmid`, `text`, … | Printable ASCII only, `\n` presses Enter. Capitals go through Caps Lock, so expect ≈0.1 s per character. |
| `console_key` | `vmid`, `combo`, … | `enter`, `esc`, `tab`, `ctrl+alt+del`, `win+r`, `alt+f4`, `ctrl+shift+esc`, `f5`, and modifier-only combinations such as `alt+shift` (layout switch). |
| `console_paste` | `vmid`, `text`, `submit?`, … | Put any Unicode text into the guest clipboard and press Ctrl+V. Needs the clipboard-enabled VGA device and a SPICE agent. |
| `console_batch` | `vmid`, `actions[]`, `observe?`, … | A chain of actions (`move`, `click`, `drag`, `scroll`, `type`, `key`, `wait`) and one frame at the end. |
| `console_clipboard` | `vmid`, `timeoutMs?` | Read the guest text clipboard (extended VNC clipboard). Empty means "no text". |
| `console_release` | `vmid` | Close the console session (emergency brake: releases the ssh child and the QEMU connection). |

Every action tool accepts a common tail: `observe` (return a frame after the action, default true),
`wake` (Shift + pointer jitter to wake a blanked display), `settleMs`, `scale`, `region`.

### Guest agent

| Tool | Parameters | What it does |
|---|---|---|
| `vm_exec` | `vmid`, `command` \| `argv`, `shell?`, `timeoutMs?` | Run a command in the guest (`cmd`/PowerShell on Windows, shell on Linux). Runs as root/SYSTEM and does not see the user's graphical session. A `command` with non-ASCII travels as a base64 envelope; `argv` must be ASCII. A command that outlives `timeoutMs` keeps running and is reported as `STILL_RUNNING` with its pid. |
| `vm_file_read` | `vmid`, `path`, `maxBytes?`, `encoding?` | Read a file (text, or base64 for binary) through the agent, in 256 KiB chunks. |
| `vm_file_write` | `vmid`, `path`, `data` \| `dataBase64` | Write a file (up to 1 MiB per call, sent over stdin); parent directories are created. |
| `vm_type_text` | `vmid`, `text`, `settleMs?`, `observe?` | Type text through the best available channel: ASCII → console, non-ASCII → the user session on Windows / `xdotool`–`wtype` on Linux. |
| `vm_status` | `vmid?` | Is the VM allowed, does the agent answer, which OS, are there open console sessions. |

## Watch the VM screen live

The **VM screen** tab in the right sidebar shows what the agent sees while it works. Add it from the
sidebar guide, or let `viewAutoOpen` reveal it the moment the agent touches a console.

* The frames are taken from the agent's own RFB session — **no second VNC session appears** and the
  `qm vncproxy` password is never reset under the agent's feet. Captures and the agent's tools share
  one session queue, so they never tear the stream for each other.
* `viewFollowAgent` keeps the panel on the VM the agent is working with; clicking a VM chip pins the
  panel to that VM instead. `viewFps` (1–4) and `viewScale` (1 / 2 / 4) control the pace and the
  resolution, and both can be changed on the fly inside the panel.
* The panel is **watch-only**: no clicks, no typing, nothing is injected into the guest. A blank
  frame is called out explicitly — the guest blanked its display or is locked.
* Frames are served by the plugin's own routes (`/pve-vm/console/frame`, `/state`, `/release`) on the
  harness web server, behind a loopback-only fence: a request is answered only when the `Host` is
  loopback (`localhost`, `127.0.0.0/8`, `[::1]`), a present `Origin` matches `Host`, and
  `sec-fetch-site: cross-site` is refused. If you bind the harness to your LAN, the panel stays dark
  by design — the same fence the harness applies to `/api`.
* **The fence is loopback, not the harness token.** These routes live outside `/api`, so the
  harness URL token does not cover them (the browser-skill overview works the same way). Any
  process on the same machine can therefore pull frames or call `/release`; that is the accepted
  price of loading frames without a token on a single-user box. Serve VMs you would not mind a
  local user seeing, and harden with a harness-issued token if that is not acceptable.
* The console session stays open while the panel streams (the idle reaper does not take it); the
  panel's “disconnect console” button closes it immediately. Streaming pauses by itself when the tab
  is hidden.

## How it works

* **Transport.** A VM has no TCP VNC port: QEMU listens on the unix socket
  `/var/run/qemu-server/<vmid>.vnc`, and `qm vncproxy` bridges it to its own stdin/stdout. The
  plugin therefore speaks RFB *through an ssh child process* — no ports, no TLS, no websocket, and
  the VNC password never lands in `argv`. `qm vncproxy` treats EOF on its stdin as "quit", so the
  plugin keeps that pipe open (the bridge also drops idle sessions after 15 minutes; the plugin
  closes its own session after `sessionIdleMs`, 5 minutes by default).
* **Input channels.** `inputChannel: auto` (default) mixes them: Caps Lock through the QEMU monitor
  for uppercase, RFB keysyms for the rest. `hmp` sends everything through `qm monitor sendkey`
  (faster, but QEMU occasionally loses modifiers below ~80 ms), `vnc` uses RFB only (uppercase is
  unreliable — QEMU emulates Shift itself and our own Shift events desynchronize it).
* **Unicode.** Windows: the plugin drops a payload file and a PowerShell typer into the guest and
  registers a scheduled task with `-LogonType Interactive`, so the text is typed *inside the user's
  session* via `SendKeys` — layout and modifiers stop mattering, and the VM is not restarted. Linux:
  `xdotool type` (X11) or `wtype` (Wayland) inside the active session; both paths run through the
  guest agent in a single call.
* **Guest channel.** All `qm` calls for one VM (guest exec, status, OS info, sendkey through the
  monitor) are serialised with a 250 ms gap: QEMU
  serves a single QMP client at a time and PVE's QMP timeout is 5 s, so back-to-back calls can steal
  each other's replies. A failed call is retried once, and only when PVE answers “agent is not
  running” — that check happens before the command is sent, so the retry cannot run anything twice.
  A file chunk carries the request marker and the real file length next to the data, so a foreign
  reply (a reused pid) or a short one is retried instead of being mistaken for the end of the file.
* **Output encoding.** Guest bytes are decoded from the raw bytes: UTF-8 when they are valid,
  otherwise the console OEM code page (`chcp`) or the system ANSI code page — whichever reads as
  text. Windows mixes the two: `cmd.exe` messages arrive in ANSI even when `chcp` reports OEM.
  Non-ASCII `command` text travels as a base64 envelope instead of the raw QMP request, and file
  data goes over stdin: both work around byte-per-character truncation in PVE
  ([#6609](https://bugzilla.proxmox.com/show_bug.cgi?id=6609)) and the ~32 KB command-line limit of
  a Windows guest.
* **Clipboard.** `ClientCutText` for writing, the extended clipboard pseudo-encoding
  (`VNC_ENCODING_CLIPBOARD_EXT`) with `CAPS`/`REQUEST`/`PROVIDE` for reading. QEMU passes the bytes
  to the guest through `qemu-vdagent`, so the VM needs `vga: <type>,clipboard=vnc` **and** a full
  stop/start (device arguments are fixed at start-up), plus a SPICE agent in the guest.
* **Frames.** RFB Raw/CopyRect rectangles are composited into RGBA (QEMU leaves alpha at zero),
  optionally cropped and downscaled, then encoded to PNG with `node:zlib`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `CONSOLE_FAILED` right after connecting, node reports nothing useful | The node's `sshd` does not accept `LC_*`, so `qm` never received the VNC password. Add `AcceptEnv LC_*` to `sshd_config` and reload sshd. |
| `Host key verification failed` | The node's key is not in `known_hosts` and the plugin runs in batch mode. Run `ssh <node>` once, or set `sshExtraOptions: ["StrictHostKeyChecking=accept-new"]`. |
| A frame comes back almost uniform (`blank: true`) | The guest blanked its display or is locked. The tools already send Shift + pointer jitter to wake it; a locked session needs a password (`console_type` + `console_key`). |
| `unable to connect to VM qmp socket — timeout after 51 retries` | Something else holds the VM's single QMP socket (a hung `qm monitor`/QMP client). Find and kill that client on the node; do not restart the VM. |
| Uppercase letters turn into garbage | You are on `inputChannel: vnc`, where QEMU's own Shift emulation fights our Shift events. Use `auto`. |
| Latin characters are not typed at all on a login screen | The guest layout is not Latin: `console_key` with `alt+shift`, then type. |
| `vm_*` tools report that the agent is not running | `qemu-guest-agent` is missing or wedged (`Restart-Service qemu-ga` on Windows, `systemctl restart qemu-guest-agent` on Linux). Console tools keep working. |
| `vm_exec` answers `STILL_RUNNING` | The command outlived `timeoutMs` and **is still running** in the guest. Give long commands a larger `timeoutMs`; the reported pid lets you poll for the result. |
| `UNICODE_ARGV_WINDOWS` | `argv` contained non-ASCII. Pass the text as `command` instead — that path travels as a base64 envelope. |
| `STALE_REPLY` | The guest agent answered with a foreign reply (a reused pid) three times in a row. Call the tool again; if it keeps happening, restart the agent (`Restart-Service QEMU-GA`). |
| `agent is not running` on a guest whose agent is installed | The QGA channel blinked — PVE's 5 s QMP timeout on a busy guest. The plugin retries once by itself; if it keeps happening, the agent is really wedged (see the row above). |
| Console dies after ~15 minutes of idling | That is the `qm vncproxy` bridge timeout. Any tool call reopens the session automatically. |

## Security

This plugin gives an agent **root-level hands inside your VMs**. Be deliberate about it:

* **Every action is executed without an approval prompt.** The only gate is `allowVmids`, which is
  empty by default; list only the VMs you are willing to let an agent touch, and keep the list
  short.
* **`vm_exec` runs as root/SYSTEM in the guest**, `vm_file_write` can write anywhere the agent can,
  and the console tools can drive a logged-in desktop. Treat an allowed VM as a compromised host:
  do not keep long-lived secrets in it while the plugin is enabled.
* **Root SSH to the node is required** (`qm` needs it). Use a dedicated key, restrict it to the
  nodes you need, and consider `from=`/`command=` restrictions in `authorized_keys` where possible.
  The plugin passes the whole host environment to the ssh child, as any ssh call does.
* **`sshExtraOptions` accepts arbitrary `-o` options**, including `ProxyCommand` — it is a
  privileged escape hatch for the person who configures the plugin, not for the model.
* **VNC passwords are generated per session** (8 printable ASCII characters) and handed to `qm`
  through the environment via `SendEnv`, so they do not show up in `ps`. The QEMU password is
  scoped to the VM and expires with the session.
* **The plugin talks only to your node.** No telemetry, no outbound connections of its own.

## Limitations

* Proxmox VE only, QEMU VMs only — no LXC containers, no other hypervisors.
* Clipboard tools need `clipboard=vnc` on the VM's VGA device and a SPICE agent in the guest;
  they move **text only** (no files, no images) and only inside a logged-in session.
* Unicode typing in Windows needs an interactive session; on the login screen only ASCII through
  `console_type` works.
* One console session per VM id, serialized with a mutex; the session is closed on idle.
* The console tools do not work with a serial console (`vga: serialN`) — there is no framebuffer.
* Not yet verified: Proxmox VE 7 and 9, multi-node clusters, Linux guests with Wayland-only desktops.

## Development

```bash
npm run check                       # node --check on every runtime file (no harness needed)
node tools/check-client.mjs         # browser bundle format (classic script, exports, inject)
node tools/check-plugin.mjs         # settings schema, tool set, JSON schemas, layout contract
```

`check-plugin.mjs` imports the plugin, and the plugin imports the harness packages
(`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`), so run it where those resolve — the
easiest way is to install the checkout into a profile with `link:` and run the script from there:

```bash
dsh plugin --profile web add link:/path/to/dsh-pve-vm
cd /path/to/dsh-pve-vm && node tools/check-plugin.mjs
```

For a bare checkout, point `DSH_PACKAGES` at the harness package directory
(`…/@deepseek-ai/dsh/node_modules/@deepseek-ai`) — the script uses it as a fallback for the
compiler it needs.

Live probes need node access only (no harness):

```bash
node tools/probe-rfb.mjs --vmid 100 --ssh-config ~/.ssh/config --out /tmp/shot.png
node tools/probe-rfb.mjs --vmid 100 --click 640,400 --after /tmp/after.png
node tools/live-test.mjs --vmid 100 --ssh-config ~/.ssh/config --out probe-out
node tools/clipboard-test.mjs --vmid 100 --text "hello" --out /tmp/clipboard.png
```

All of them talk to the node exactly like the plugin does (`qm vncproxy` over ssh), so they are the
fastest way to tell a plugin bug from a node-side problem.

## License

MIT — see [LICENSE](LICENSE).

Proxmox® is a registered trademark of Proxmox Server Solutions GmbH. This project is an
independent plugin and is not affiliated with or endorsed by Proxmox Server Solutions GmbH or by
the DeepSeek Harness project.
