import { randomUUID } from 'node:crypto';
import type { ApprovedItem, MusicItem } from '../shared/types.js';
export interface AdultBinding {
  deviceId: string;
  profileId: string;
  revision: number;
}
export interface AdultSelection extends AdultBinding {
  item: ApprovedItem;
  source: MusicItem;
}
/** Search results are capabilities scoped to an authenticated pairing/profile.
 * Browsers never choose an arbitrary provider URI for unrestricted playback. */
export class AdultCatalogue {
  private entries = new Map<string, AdultSelection & { expires: number }>();
  remember(binding: AdultBinding, source: MusicItem): ApprovedItem {
    this.prune();
    const existing = [...this.entries.values()].find(
      (e) => this.same(e, binding) && e.source.uri === source.uri,
    );
    const item: ApprovedItem = {
      ...source,
      id: existing?.item.id ?? `adult:${randomUUID()}`,
      displayName: source.name,
      position: 0,
      artworkOverride: null,
      hiddenTrackIds: [],
    };
    this.entries.set(item.id, {
      ...binding,
      item,
      source,
      expires: Date.now() + 15 * 60000,
    });
    const owned = [...this.entries.values()].filter(
      (e) => e.deviceId === binding.deviceId,
    );
    for (const entry of owned.slice(0, Math.max(0, owned.length - 100)))
      this.entries.delete(entry.item.id);
    if (this.entries.size > 1000)
      this.entries.delete(this.entries.keys().next().value!);
    return item;
  }
  get(binding: AdultBinding, id: string): AdultSelection | undefined {
    this.prune();
    const entry = this.entries.get(id);
    return entry && this.same(entry, binding) ? entry : undefined;
  }
  private same(a: AdultBinding, b: AdultBinding) {
    return (
      a.deviceId === b.deviceId &&
      a.profileId === b.profileId &&
      a.revision === b.revision
    );
  }
  private prune() {
    for (const [id, entry] of this.entries)
      if (entry.expires < Date.now()) this.entries.delete(id);
  }
  clear(deviceId: string) {
    for (const [id, e] of this.entries)
      if (e.deviceId === deviceId) this.entries.delete(id);
  }
}
