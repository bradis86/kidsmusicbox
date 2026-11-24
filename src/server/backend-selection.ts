import type { BackendMode } from '../shared/types.js';
import type { Store } from './db.js';
// Preserve approvals and preferences; only playback ownership and target are scoped to a backend.
export function selectBackend(
  store: Store,
  mode: BackendMode,
  configuredPlayer = '',
) {
  const previous = store.get<BackendMode>('selectedBackend', 'mock');
  if (previous !== mode) {
    store.set(`target:${previous}`, store.settings().playerId);
    const target = store.get<string>(
      `target:${mode}`,
      mode === 'mock' ? 'mock-lenovo' : configuredPlayer,
    );
    store.set('settings', { ...store.settings(), playerId: target });
    store.set('activeCollection', null);
    store.set('activeTrackUris', []);
    store.set('pendingStop', false);
    store.set('settingsDirty', false);
    store.log(
      `Music backend changed to ${mode}; previous approvals retained separately`,
    );
  } else if (!store.get('settings', null)) {
    store.set('settings', {
      ...store.settings(),
      playerId: mode === 'mock' ? 'mock-lenovo' : configuredPlayer,
    });
  }
  store.set('selectedBackend', mode);
}
