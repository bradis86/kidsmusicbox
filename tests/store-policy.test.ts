import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/db';
import {
  defaultSettings,
  SettingsSchema,
  type ApprovedItem,
} from '../src/shared/types';
import { sampleLibrary } from '../src/server/adapters/mock';
import { policy, inWindow, nextClockTime } from '../src/server/policy';
const approved = (i: number): ApprovedItem => ({
  ...sampleLibrary[i],
  displayName: sampleLibrary[i].name,
  position: i,
  artworkOverride: null,
  hiddenTrackIds: [],
});
describe('persistent configuration', () => {
  it('retains approvals, order, settings and paired sessions across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jukebox-db-'));
    try {
      const path = join(dir, 'hub.sqlite');
      let s = new Store(path);
      s.approve(approved(0));
      s.approve(approved(1));
      s.reorder([sampleLibrary[1].id, sampleLibrary[0].id]);
      s.set('settings', {
        ...defaultSettings,
        deviceName: 'Ruby’s music',
        maxVolume: 40,
      });
      const session = s.createSession('child');
      s.close();
      s = new Store(path);
      expect(s.collection().map((i) => i.id)).toEqual([
        sampleLibrary[1].id,
        sampleLibrary[0].id,
      ]);
      expect(s.settings().deviceName).toBe('Ruby’s music');
      expect(s.session(session.token)?.role).toBe('child');
      expect(() =>
        s.reorder([sampleLibrary[0].id, sampleLibrary[0].id]),
      ).toThrow();
      s.remove(sampleLibrary[1].id);
      expect(s.collection()).toHaveLength(1);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('uses timezone-aware overnight windows with independent screen/music rules', () => {
    const s = { ...defaultSettings, screenScheduleEnabled: true };
    const night = new Date('2026-11-11T14:00:00Z');
    expect(policy(s, night)).toMatchObject({ bedtime: false, screenOff: true });
    expect(policy({ ...s, bedtimeEnabled: true }, night).bedtime).toBe(true);
    expect(policy({ ...s, screenOverride: 'on' }, night).screenOff).toBe(false);
    expect(
      policy({ ...s, screenOverride: 'off' }, new Date('2026-11-11T04:00:00Z'))
        .screenOff,
    ).toBe(true);
    expect(inWindow('07:00', '07:00', 'Australia/Perth', night)).toBe(false);
    expect(policy(s, new Date('2026-11-11T23:00:00Z')).screenOff).toBe(false);
  });
  it('validates parent settings including timezones and volume consistency', () => {
    expect(
      SettingsSchema.safeParse({ ...defaultSettings, timezone: 'Moon/Cheese' })
        .success,
    ).toBe(false);
    expect(
      SettingsSchema.safeParse({
        ...defaultSettings,
        maxVolume: 10,
        startupVolume: 30,
      }).success,
    ).toBe(false);
    expect(
      SettingsSchema.safeParse({ ...defaultSettings, screenOffAt: '25:00' })
        .success,
    ).toBe(false);
  });
});

it('stops Sleep Music at the next representable cutoff during clock changes', () => {
  const settings = {
    ...defaultSettings,
    timezone: 'Australia/Sydney',
    sleepMusicEnd: '02:30',
  };
  expect(
    nextClockTime(
      settings.sleepMusicEnd,
      settings.timezone,
      new Date('2026-10-03T13:00:00Z'),
    ),
  ).toBe(Date.parse('2026-10-03T16:00:00Z'));
  expect(
    nextClockTime(
      settings.sleepMusicEnd,
      settings.timezone,
      new Date('2026-04-04T15:45:00Z'),
    ),
  ).toBe(Date.parse('2026-04-04T16:30:00Z'));
});
