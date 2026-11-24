import { expect, it, vi } from 'vitest';
import { FullyDevice, type FullyApi } from '../src/client/fullyDevice';
const policy = {
  canControlVolume: true,
  screenOff: false,
  volume: 25,
  maxVolume: 100,
};
function fixture() {
  let on = true;
  const api: FullyApi = {
    bind: vi.fn(),
    getAudioVolume: () => 36,
    setAudioVolume: vi.fn(),
    getScreenOn: () => on,
    turnScreenOn: vi.fn(() => {
      on = true;
    }),
    turnScreenOff: vi.fn(() => {
      on = false;
    }),
  };
  return {
    api,
    setOn: (value: boolean) => {
      on = value;
    },
  };
}
it('routes hardware keys through the shared UI queue and controls native volume', () => {
  const f = fixture(),
    step = vi.fn(),
    error = vi.fn();
  const d = new FullyDevice(f.api, policy, step, error);
  d.key(5);
  d.key(-5);
  expect(step.mock.calls).toEqual([[5], [-5]]);
  expect(f.api.setAudioVolume).toHaveBeenLastCalledWith(25, 3);
  d.volume(65);
  expect(f.api.setAudioVolume).toHaveBeenLastCalledWith(65, 3);
  expect(d.usesNativeVolume).toBe(true);
  d.update({ ...policy, maxVolume: 50 });
  expect(f.api.setAudioVolume).toHaveBeenLastCalledWith(50, 3);
  d.volume(90);
  expect(f.api.setAudioVolume).toHaveBeenLastCalledWith(50, 3);
  d.volume(-5);
  expect(f.api.setAudioVolume).toHaveBeenLastCalledWith(0, 3);
  expect(error).not.toHaveBeenCalled();
  d.dispose();
});
it('does not let an inactive player change app volume', () => {
  const f = fixture(),
    step = vi.fn(),
    d = new FullyDevice(f.api, policy, step, vi.fn());
  d.update({ ...policy, canControlVolume: false });
  d.key(5);
  expect(step).not.toHaveBeenCalled();
  expect(d.usesNativeVolume).toBe(false);
  d.dispose();
});
it('keeps the backlight aligned with app policy, including external sleep and wake', () => {
  const f = fixture(),
    d = new FullyDevice(f.api, policy, vi.fn(), vi.fn());
  d.update({ ...policy, screenOff: true });
  expect(f.api.turnScreenOff).toHaveBeenCalledWith(true);
  f.setOn(true);
  d.screenChanged();
  expect(f.api.turnScreenOff).toHaveBeenCalledTimes(2);
  d.update(policy);
  expect(f.api.turnScreenOn).toHaveBeenCalledTimes(1);
  f.setOn(false);
  d.screenChanged();
  expect(f.api.turnScreenOn).toHaveBeenCalledTimes(2);
  d.dispose();
  f.setOn(true);
  d.screenChanged();
  expect(f.api.turnScreenOff).toHaveBeenCalledTimes(2);
});
it('reports native failures and falls back to browser gain', () => {
  const f = fixture(),
    step = vi.fn(),
    error = vi.fn();
  const d = new FullyDevice(f.api, policy, step, error);
  vi.mocked(f.api.setAudioVolume).mockImplementation(() => {
    throw new Error('Device unavailable');
  });
  d.volume(65);
  expect(d.usesNativeVolume).toBe(false);
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'Device unavailable' }),
  );
  d.dispose();
  d.key(5);
  expect(error).toHaveBeenCalledTimes(1);
  for (const name of ['volumeUp', 'volumeDown', 'screenOn', 'screenOff'])
    expect(f.api.bind).toHaveBeenCalledWith(name, '');
});
it('rejects an unreadable native volume rather than raising the amplifier level', () => {
  const f = fixture();
  f.api.getAudioVolume = () => NaN;
  expect(() => new FullyDevice(f.api, policy, vi.fn(), vi.fn())).toThrow(
    'could not read',
  );
  expect(f.api.setAudioVolume).not.toHaveBeenCalled();
});

it('applies daytime brightness and preserves bedtime blanking and wake', () => {
  const f = fixture();
  f.api.setScreenBrightness = vi.fn();
  const d = new FullyDevice(f.api, policy, vi.fn(), vi.fn());
  const touchBlank = { ...policy, screenOff: true, keepTouchActive: true };
  d.update(touchBlank);
  d.update(touchBlank);
  expect(f.api.setScreenBrightness).toHaveBeenCalledExactlyOnceWith(0);
  expect(f.api.turnScreenOff).not.toHaveBeenCalled();
  const touchWake = { ...policy, keepTouchActive: true };
  d.update(touchWake);
  d.update(touchWake);
  expect(f.api.setScreenBrightness).toHaveBeenCalledTimes(2);
  expect(f.api.setScreenBrightness).toHaveBeenLastCalledWith(-1);
  d.update(touchBlank);
  expect(f.api.setScreenBrightness).toHaveBeenLastCalledWith(0);
  d.update(policy);
  expect(f.api.setScreenBrightness).toHaveBeenLastCalledWith(-1);
  const daytime = { ...policy, screenOnBrightness: 255 };
  d.update(daytime);
  expect(f.api.setScreenBrightness).toHaveBeenLastCalledWith(255);
  d.update(policy);
  expect(f.api.setScreenBrightness).toHaveBeenLastCalledWith(-1);
  d.update(touchBlank);
  d.update({ ...policy, screenOff: true });
  expect(f.api.setScreenBrightness).toHaveBeenLastCalledWith(-1);
  expect(f.api.turnScreenOff).toHaveBeenCalledExactlyOnceWith(true);
});
