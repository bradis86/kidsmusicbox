import { it, expect, vi } from 'vitest';
import { RendererRecovery } from '../src/server/renderer-recovery';
function fixture(extra = false) {
  let time = 0;
  const links = ['6600', '6601'].map((port) => ({
    playerId: 'mpd_192.0.2.10_' + port,
    up: false,
    playing: false,
    connected() {
      return this.up;
    },
    active() {
      return this.playing;
    },
  }));
  const rpc = vi.fn(async (command: string) => {
    if (command === 'providers') return [{ domain: 'mpd', instance_id: 'mpd' }];
    if (command === 'config/providers/get')
      return {
        values: {
          manual_discovery_ip_addresses: {
            value: [
              '192.0.2.10:6600',
              '192.0.2.10:6601',
              ...(extra ? ['192.0.2.20:6600'] : []),
            ],
          },
        },
      };
    if (command === 'config/providers/reload')
      for (const l of links) l.up = true;
    return null;
  });
  const recovery = new RendererRecovery(
    { rpc },
    links,
    vi.fn(),
    () => time,
    async (ms) => {
      time += ms;
    },
  );
  return { recovery, rpc, links };
}
it('recovers stale MA availability using verified dedicated renderers and shares concurrent recovery', async () => {
  const { recovery, rpc, links } = fixture();
  await Promise.all([
    recovery.ensure(links[0].playerId),
    recovery.ensure(links[1].playerId),
  ]);
  expect(
    rpc.mock.calls.filter((c) => c[0] === 'config/providers/reload'),
  ).toHaveLength(1);
  expect(rpc).toHaveBeenCalledWith('config/providers/reload', {
    instance_id: 'mpd',
  });
  await recovery.ensure();
  expect(rpc).toHaveBeenCalledTimes(3);
});
it('never reloads while an existing receiver can still be playing buffered audio', async () => {
  const { recovery, rpc, links } = fixture();
  links[1].playing = true;
  await expect(recovery.ensure(links[0].playerId)).rejects.toThrow(
    'other player',
  );
  expect(rpc).not.toHaveBeenCalled();
  links[1].up = true;
  await recovery.ensure(links[1].playerId);
  expect(rpc).not.toHaveBeenCalled();
});
it('refuses to reload an MPD provider shared with any unrelated speaker', async () => {
  const { recovery, rpc } = fixture(true);
  await expect(recovery.ensure()).rejects.toThrow('Parent settings');
  expect(rpc.mock.calls.map((c) => c[0])).not.toContain(
    'config/providers/reload',
  );
});
it('backs off when reconnection does not restore real socket connections', async () => {
  const { recovery, rpc } = fixture();
  rpc.mockImplementation(async (command) => {
    if (command === 'providers') return [{ domain: 'mpd', instance_id: 'mpd' }];
    if (command === 'config/providers/get')
      return {
        values: {
          manual_discovery_ip_addresses: {
            value: ['192.0.2.10:6600', '192.0.2.10:6601'],
          },
        },
      };
    return null;
  });
  await expect(recovery.ensure()).rejects.toThrow('recovering');
  await expect(recovery.ensure()).rejects.toThrow('recovering');
  expect(
    rpc.mock.calls.filter((c) => c[0] === 'config/providers/reload'),
  ).toHaveLength(1);
});
it('waits for pending recovery even if a different target connects early', async () => {
  const { recovery, rpc, links } = fixture();
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (command) => {
    if (command === 'config/providers/reload') {
      links[0].up = true;
      await gate;
      links[1].up = true;
      return null;
    }
    return original(command);
  });
  const pending = recovery.ensure();
  await vi.waitFor(() => expect(links[0].up).toBe(true));
  let returned = false;
  const second = recovery.ensure(links[0].playerId).then(() => {
    returned = true;
  });
  await Promise.resolve();
  expect(returned).toBe(false);
  finish();
  await Promise.all([pending, second]);
});
