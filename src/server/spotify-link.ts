import { BackendError } from './adapters/backend.js';
// Parse only; never fetch user-supplied hosts or follow shortened URL redirects.
export function spotifyPlaylistUri(link: string): string {
  const direct = /^spotify:playlist:([A-Za-z0-9]{22})$/.exec(link);
  if (direct) return `spotify://playlist/${direct[1]}`;
  try {
    const url = new URL(link);
    const match = /^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{22})\/?$/.exec(
      url.pathname,
    );
    if (
      url.protocol === 'https:' &&
      url.hostname === 'open.spotify.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      match
    )
      return `spotify://playlist/${match[1]}`;
  } catch {
    /* Return a helpful validation error below. */
  }
  throw new BackendError(
    'Paste a Spotify playlist Share link (https://open.spotify.com/playlist/…) or spotify:playlist:… URI. For shortened links, open Spotify and copy the full playlist link.',
    422,
  );
}
