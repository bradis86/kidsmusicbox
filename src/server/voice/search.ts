import type { ApprovedItem, Track, VoiceMatch } from '../../shared/types.js';
import { trackHidden } from '../../shared/music.js';
const normalize = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
function similarity(a: string, b: string) {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  if (b.includes(a) && a.length >= 4) return 0.9;
  const x = a.replaceAll(' ', ''),
    y = b.replaceAll(' ', '');
  let row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const next = [i];
    for (let j = 1; j <= y.length; j++)
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return 1 - row[y.length] / Math.max(x.length, y.length);
}
export function matchApproved(
  text: string,
  entries: { item: ApprovedItem; tracks: Track[] }[],
): VoiceMatch[] {
  const query = normalize(text)
    .replace(
      /^(?:please )?(?:play|find|search for|search|show me)(?: the song| the track| the album| the playlist| some)? /,
      '',
    )
    .replace(/ please$/, '');
  if (!query || query.length > 200) return [];
  const matches: { result: VoiceMatch; score: number }[] = [];
  for (const { item, tracks } of entries) {
    const collectionScore = Math.max(
      ...[item.name, item.displayName, item.artist].map((name) =>
        similarity(query, normalize(name)),
      ),
    );
    if (item.kind !== 'track' && collectionScore >= 0.78)
      matches.push({
        score: collectionScore,
        result: {
          kind: item.kind,
          collectionId: item.id,
          name: item.displayName,
          artist: item.artist,
          artwork: item.artworkOverride ?? item.artwork,
        },
      });
    for (const track of tracks) {
      if (trackHidden(item.hiddenTrackIds, track)) continue;
      const score = Math.max(
        ...[
          ...(item.kind === 'track' ? [item.displayName] : []),
          track.name,
          track.artist,
          `${track.name} by ${track.artist}`,
        ].map((name) => similarity(query, normalize(name))),
      );
      if (score >= 0.78)
        matches.push({
          score,
          result: {
            kind: 'track',
            collectionId: item.id,
            trackId: track.id,
            name: item.kind === 'track' ? item.displayName : track.name,
            artist: track.artist,
            artwork:
              item.kind === 'track'
                ? (item.artworkOverride ?? track.artwork)
                : track.artwork,
          },
        });
    }
  }
  const seen = new Set<string>();
  return matches
    .sort(
      (a, b) => b.score - a.score || a.result.name.localeCompare(b.result.name),
    )
    .filter(({ result }) => {
      const key =
        result.kind === 'track' ? result.trackId! : result.collectionId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12)
    .map((m) => m.result);
}
