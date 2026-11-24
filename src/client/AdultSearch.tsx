import { useEffect, useRef, useState } from 'react';
import { Search, ArrowRight } from 'lucide-react';
import type { ApprovedItem } from '../shared/types';
import { api } from './api';
import { Cover, ErrorNotice } from './components';
export function AdultSearch({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (item: ApprovedItem) => void;
}) {
  const [query, setQuery] = useState(''),
    [items, setItems] = useState<ApprovedItem[]>([]),
    [pending, setPending] = useState(false),
    [searched, setSearched] = useState(false),
    [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function search() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError('');
    setItems([]);
    setSearched(false);
    try {
      const result = await api<ApprovedItem[]>(
        '/api/child/catalogue/search?search=' +
          encodeURIComponent(query.trim()),
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        setItems(result);
        setSearched(true);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <section className="adult-search" aria-label="Full music catalogue">
      <h2>Search all music</h2>
      <p>
        Find songs, albums and playlists on Spotify and your Music Assistant
        sources.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label className="adult-search-field">
          <Search size={21} />
          <input
            type="search"
            aria-label="Search all music"
            placeholder="Song, artist, album or playlist"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={120}
            disabled={disabled}
          />
        </label>
        <button
          className="button primary"
          disabled={disabled || pending || !query.trim()}
        >
          Search
        </button>
      </form>
      <ErrorNotice message={error} />
      {pending && <p role="status">Searching your music sources…</p>}
      {searched && !items.length && (
        <p role="status">Nothing found. Try another song, artist or album.</p>
      )}
      {items.length > 0 && (
        <div
          className="adult-search-results"
          role="list"
          aria-label="Music search results"
        >
          {items.map((item) => (
            <div key={item.id} role="listitem">
              <button
                className="adult-search-result"
                aria-label={`Open ${item.displayName}`}
                onClick={() => onSelect(item)}
                disabled={disabled || pending}
              >
                <Cover src={item.artwork} loading="lazy" />
                <span>
                  <strong>{item.displayName}</strong>
                  <small>
                    {item.artist} ·{' '}
                    {item.kind === 'track'
                      ? 'Song'
                      : item.kind === 'album'
                        ? 'Album'
                        : 'Playlist'}
                  </small>
                </span>
                <ArrowRight size={21} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
