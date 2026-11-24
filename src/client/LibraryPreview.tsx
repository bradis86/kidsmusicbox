import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Headphones,
  ListMusic,
  Moon,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import type { MusicItem, Track } from '../shared/types';
import { AudioSample } from './AudioSample';
import { api, send } from './api';
import { Cover, ErrorNotice, IconButton, time } from './components';

export function LibraryPreview({
  item,
  approved,
  onClose,
  onApproved,
  onSleepAdded,
  sleepSongs,
  canSample,
}: {
  item: MusicItem;
  approved: boolean;
  onClose: () => void;
  onApproved: () => void;
  onSleepAdded: (songs: Track[]) => void;
  sleepSongs: Track[];
  canSample: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sampleIndex, setSampleIndex] = useState<number | null>(null);
  async function addToSleep(trackId: string) {
    setSaving(true);
    setError('');
    try {
      onSleepAdded(
        await send<Track[]>('/api/admin/sleep-music', {
          itemId: item.id,
          trackId,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<Track[]>(`/api/admin/tracks?id=${encodeURIComponent(item.id)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (active) setTracks(result);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [item.id, attempt]);
  async function approve() {
    setSaving(true);
    setError('');
    try {
      await send('/api/admin/collection', { id: item.id });
      setSaved(true);
      onApproved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="library-preview"
      aria-label={`Preview ${item.name}`}
      onCancel={onClose}
    >
      <header>
        <h2>
          <ListMusic size={22} /> Track preview
        </h2>
        <IconButton icon={X} label="Close preview" onClick={onClose} />
      </header>
      <div className="preview-heading">
        <Cover src={item.artwork} alt={item.name} />
        <div>
          <span className="eyebrow">
            {item.kind === 'track' ? 'Song' : item.kind}
          </span>
          <h3>{item.name}</h3>
          <p>{item.artist}</p>
          {!loading && !error && (
            <span className="muted">
              {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
            </span>
          )}
        </div>
      </div>
      <div className="preview-tracks" aria-busy={loading}>
        {loading ? (
          <p role="status">Loading tracks…</p>
        ) : (
          <>
            <ErrorNotice message={error} />
            {error && (
              <button
                className="button"
                onClick={() => setAttempt((n) => n + 1)}
              >
                <RefreshCw size={16} /> Try again
              </button>
            )}
            {!error && !tracks.length && (
              <p>No playable tracks are available for this item.</p>
            )}
            {!!tracks.length && (
              <ol aria-label="Playlist tracks">
                {tracks.map((track, index) => {
                  const identities = [track.uri, ...(track.sourceUris ?? [])];
                  const inSleep = sleepSongs.some((song) =>
                    [song.uri, ...(song.sourceUris ?? [])].some((uri) =>
                      identities.includes(uri),
                    ),
                  );
                  return (
                    <li key={`${track.id}-${index}`}>
                      <span className="preview-track-number">{index + 1}</span>
                      <Cover src={track.artwork} alt="" loading="lazy" />
                      <span className="preview-track-title">
                        <strong>{track.name}</strong>
                        <small>{track.artist}</small>
                        <span className="sleep-track-actions">
                          {canSample && (
                            <button
                              className="button"
                              type="button"
                              onClick={() =>
                                setSampleIndex(
                                  sampleIndex === index ? null : index,
                                )
                              }
                            >
                              <Headphones size={16} />{' '}
                              {sampleIndex === index
                                ? 'Close sample'
                                : 'Listen to sample'}
                            </button>
                          )}
                          <button
                            className="button"
                            type="button"
                            disabled={saving || inSleep}
                            onClick={() => void addToSleep(track.id)}
                          >
                            <Moon size={16} />{' '}
                            {inSleep ? 'In Sleep Music' : 'Add to Sleep Music'}
                          </button>
                        </span>
                        {sampleIndex === index && (
                          <AudioSample
                            key={track.id}
                            query={new URLSearchParams({
                              itemId: item.id,
                              trackId: track.id,
                            }).toString()}
                          />
                        )}
                      </span>
                      <span className="preview-track-duration">
                        {time(track.duration)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
      </div>
      <footer>
        <p className="muted">Samples play here in Parent controls.</p>
        <button
          className={`button ${approved || saved ? 'approved-button' : 'primary'}`}
          disabled={approved || saved || saving}
          onClick={() => void approve()}
        >
          {approved || saved ? <Check size={17} /> : <Plus size={17} />}
          {approved || saved
            ? 'On their shelf'
            : saving
              ? 'Adding…'
              : `Approve ${item.kind === 'track' ? 'song' : item.kind}`}
        </button>
      </footer>
    </dialog>
  );
}
