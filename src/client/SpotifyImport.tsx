import { useState } from 'react';
import { Check, Link2, ListMusic, Plus } from 'lucide-react';
import type { MusicItem } from '../shared/types';
import { send } from './api';
import { Cover, ErrorNotice } from './components';
export function SpotifyImport({
  approvedIds,
  onApproved,
  onPreview,
}: {
  approvedIds: string[];
  onApproved: () => void;
  onPreview: (item: MusicItem) => void;
}) {
  const [link, setLink] = useState('');
  const [item, setItem] = useState<MusicItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const approved = !!item && approvedIds.includes(item.id);
  async function resolve() {
    setBusy(true);
    setError('');
    setItem(null);
    try {
      setItem(await send('/api/admin/spotify/resolve', { link }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!item) return;
    setBusy(true);
    setError('');
    try {
      await send('/api/admin/collection', { id: item.id });
      onApproved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="spotify-import panel">
      <h2>
        <Link2 size={21} /> Add a Spotify playlist
      </h2>
      <p>
        Copy a playlist’s Share link from Spotify. Preview it here, then approve
        it for their library.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void resolve();
        }}
      >
        <label>
          Spotify playlist link
          <input
            aria-label="Spotify playlist link"
            disabled={busy}
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setItem(null);
              setError('');
            }}
            placeholder="https://open.spotify.com/playlist/…"
            required
            maxLength={1000}
          />
        </label>
        <button
          className="button primary"
          disabled={busy || !link.trim()}
          type="submit"
        >
          {busy ? 'Loading…' : 'Preview playlist'}
        </button>
      </form>
      <ErrorNotice message={error} />
      {item && (
        <div className="spotify-preview">
          <Cover src={item.artwork} alt={item.name} />
          <div>
            <strong>{item.name}</strong>
            <p>{item.artist}</p>
            <button
              className="button preview-button"
              onClick={() => onPreview(item)}
            >
              <ListMusic size={16} /> View tracks
            </button>
            <button
              className="button primary"
              disabled={busy || approved}
              onClick={() => void approve()}
            >
              {approved ? <Check size={16} /> : <Plus size={16} />}
              {approved ? 'In their library' : 'Approve playlist'}
            </button>
          </div>
        </div>
      )}
      <small>
        Requires Music Assistant with your Spotify provider connected. Spotify
        links do not provide downloadable music or turn mock mode into audio
        playback.
      </small>
    </section>
  );
}
