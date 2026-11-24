import { describe, it, expect } from 'vitest';
import { Store } from '../src/server/db';
import { selectBackend } from '../src/server/backend-selection';
import { defaultSettings } from '../src/shared/types';
import { sampleLibrary } from '../src/server/adapters/mock';
describe('backend transitions', () => {
  it('retains settings, approvals and sessions while clearing stale queue ownership', () => {
    const store = new Store(':memory:');
    store.set('settings', {
      ...defaultSettings,
      maxVolume: 45,
      deviceName: 'Her music',
    });
    store.approve({
      ...sampleLibrary[0],
      displayName: 'Custom name',
      position: 0,
      artworkOverride: null,
      hiddenTrackIds: [],
    });
    const session = store.createSession('child');
    store.set('activeCollection', sampleLibrary[0].id);
    store.set('pendingStop', true);
    selectBackend(store, 'music-assistant', 'browser');
    expect(store.settings()).toMatchObject({
      playerId: 'browser',
      maxVolume: 45,
      deviceName: 'Her music',
    });
    expect(store.get('activeCollection', 'stale')).toBeNull();
    expect(store.get('pendingStop', true)).toBe(false);
    expect(store.collection()[0].displayName).toBe('Custom name');
    expect(store.session(session.token)?.role).toBe('child');
    store.set('settings', { ...store.settings(), playerId: 'chosen-speaker' });
    selectBackend(store, 'mock');
    expect(store.settings().playerId).toBe('mock-lenovo');
    selectBackend(store, 'music-assistant');
    expect(store.settings().playerId).toBe('chosen-speaker');
    store.close();
  });
});
