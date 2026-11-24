import type { Track } from './types.js';

// MA can replace a Spotify identity with a canonical library identity. A parent
// restriction must continue to apply to every equivalent identity it supplies.
export function trackHidden(hidden: string[], track: Track) {
  return [track.id, track.uri, ...(track.sourceUris ?? [])].some((id) =>
    hidden.includes(id),
  );
}
