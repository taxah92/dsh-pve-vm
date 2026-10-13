/**
 * dsh-pve-vm — control of Proxmox VE VMs from DeepSeek Harness.
 *
 * Two channels over a single ssh transport to the node:
 *   • console (VNC/RFB through `qm vncproxy`) — see the screen and click, any guest OS;
 *   • guest agent (`qm guest exec`/`qm guest cmd`) — commands, files, state.
 *
 * Settings arrive through the `settings` service from the form built from the exported
 * schema {@link Config}; the id of the entry in `cordis.patch.yml` must match the
 * settings namespace (`pve-vm`).
 */
import { Config, resolveSettings, snapshot } from './lib/config.js';
import { VmController } from './lib/session.js';
import { ConsoleView } from './lib/view.js';
import { registerViewRoutes } from './lib/routes.js';
import { consoleTools } from './tools/console.js';
import { guestTools } from './tools/guest.js';

export { Config };
export const name = 'pve-vm';
export const inject = ['tools', 'attachments', 'subprocess'];

/**
 * Attach the plugin to the composition.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {Record<string, {get?: () => unknown}>} config live settings values.
 */
export function apply(ctx, config) {
  const settings = () => resolveSettings(snapshot(config));
  const controller = new VmController({
    settings,
    spawn: (spec) => ctx.subprocess.spawn(spec),
    cwd: process.cwd(),
  });
  ctx.effect(() => () => controller.closeAll());

  const deps = { controller, settings, attachments: ctx.attachments };
  for (const tool of [...consoleTools(deps), ...guestTools(deps)]) ctx.tools.register(tool);

  // Observation panel: the client half pulls frames from these routes. A
  // composition may have no web server at all (headless profile) — then there is
  // simply no panel while the tools keep working, so the dependency is declared
  // through ctx.inject instead of the plugin's mandatory `inject` list.
  const view = new ConsoleView({ controller, settings });
  ctx.inject(['webServer'], (scoped) => registerViewRoutes(scoped.webServer, { view }));

  // The computer-use slot is per composition: if another provider has already taken it,
  // the plugin tools still work, so the error is only recorded.
  ctx.inject(['computerUse'], (scoped) => {
    try {
      scoped.computerUse.register('pve-vm');
    } catch (error) {
      scoped.logger?.warn?.(`pve-vm: the computer-use slot is taken: ${error?.message ?? error}`);
    }
  });
}
