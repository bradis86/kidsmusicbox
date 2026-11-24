import { expect, it } from 'vitest';
import { matchApproved } from '../src/server/voice/search';
import { MockBackend, sampleLibrary } from '../src/server/adapters/mock';
const backend = new MockBackend();
const item = {
  ...sampleLibrary[0],
  displayName: 'Sunbeams favourites',
  position: 0,
  artworkOverride: null,
  hiddenTrackIds: [] as string[],
};
const tracks = await backend.tracks(item);
it('matches spoken commands and artist pronunciation within the supplied approved shelf', () => {
  expect(
    matchApproved('Play Sunspun.', [{ item, tracks }]).map((m) => m.name),
  ).toEqual(['Sunspun']);
  expect(
    matchApproved('Sun Beams', [{ item, tracks }]).some(
      (m) => m.name === 'Sunspun',
    ),
  ).toBe(true);
  expect(
    matchApproved('Sunbeams favourites', [{ item, tracks }])[0].collectionId,
  ).toBe(item.id);
});
it('excludes hidden and unapproved music, vague recognition and unrelated echoed lists', () => {
  expect(
    matchApproved('Sunspun', [
      { item: { ...item, hiddenTrackIds: [tracks[0].id] }, tracks },
    ]),
  ).toEqual([]);
  expect(matchApproved('Orbit Lanterns', [{ item, tracks }])).toEqual([]);
  expect(matchApproved('We', [{ item, tracks }])).toEqual([]);
  expect(
    matchApproved('Orbit Lanterns Mapmakers Club Comet Parade Old Dance Hits', [
      { item, tracks },
    ]),
  ).toEqual([]);
  expect(matchApproved('', [{ item, tracks }])).toEqual([]);
});
it('uses an approved duplicate that remains visible when another collection hides the song', () => {
  const entries = [
    { item: { ...item, hiddenTrackIds: [tracks[0].id] }, tracks },
    { item: { ...item, id: 'another-approved-list' }, tracks },
  ];
  expect(matchApproved('Sunspun', entries)).toMatchObject([
    { trackId: tracks[0].id, collectionId: 'another-approved-list' },
  ]);
});

it('matches an approved standalone song once, including parent rename, and respects hiding', () => {
  const single = {
    ...item,
    id: tracks[0].uri,
    uri: tracks[0].uri,
    kind: 'track' as const,
    displayName: 'My special song',
  };
  expect(
    matchApproved('My special song', [{ item: single, tracks: [tracks[0]] }]),
  ).toMatchObject([
    {
      kind: 'track',
      collectionId: single.id,
      trackId: tracks[0].id,
      name: 'My special song',
    },
  ]);
  expect(
    matchApproved('Sunspun', [{ item: single, tracks: [tracks[0]] }]),
  ).toHaveLength(1);
  expect(
    matchApproved('Sunspun', [
      {
        item: { ...single, hiddenTrackIds: [tracks[0].id] },
        tracks: [tracks[0]],
      },
    ]),
  ).toEqual([]);
  expect(
    matchApproved('Sunspun', [
      {
        item: { ...single, hiddenTrackIds: [tracks[0].id] },
        tracks: [
          {
            ...tracks[0],
            id: 'library://track/new-canonical-id',
            sourceUris: [tracks[0].id, tracks[0].uri],
          },
        ],
      },
    ]),
  ).toEqual([]);
});
