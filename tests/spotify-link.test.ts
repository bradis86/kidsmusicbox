import { describe, it, expect } from 'vitest';
import { spotifyPlaylistUri } from '../src/server/spotify-link';
const id = '37i9dQZF1DXcBWIGoYBM5M';
describe('Spotify playlist links', () => {
  it('normalises share links, locale links and native URIs without following URLs', () => {
    for (const value of [
      `https://open.spotify.com/playlist/${id}?si=sharing`,
      `https://open.spotify.com/intl-en/playlist/${id}`,
      `spotify:playlist:${id}`,
    ])
      expect(spotifyPlaylistUri(value)).toBe(`spotify://playlist/${id}`);
  });
  it('rejects arbitrary hosts, tracks, credentials, redirects and malformed IDs', () => {
    for (const value of [
      `https://open.spotify.com.evil.test/playlist/${id}`,
      `https://open.spotify.com/track/${id}`,
      `https://user:pass@open.spotify.com/playlist/${id}`,
      `http://open.spotify.com/playlist/${id}`,
      'https://spotify.link/short',
      'file:///etc/passwd',
      'https://open.spotify.com/playlist/invalid',
    ])
      expect(() => spotifyPlaylistUri(value)).toThrow('Spotify playlist');
  });
});
