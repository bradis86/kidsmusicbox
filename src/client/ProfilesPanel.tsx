import { useCallback, useEffect, useState } from 'react';
import { Heart, ThumbsDown, Users } from 'lucide-react';
import { api, send } from './api';
import type {
  ChildProfile,
  TrackPreference,
  TrackReaction,
  ApprovedItem,
  Track,
} from '../shared/types';
import { Cover, ErrorNotice } from './components';
type Device = {
  id: string;
  name: string;
  profileId: string;
  revision: number;
  audioAssigned?: boolean;
  online?: boolean;
  playback?: { status: string; track: Track | null; volume: number };
};
export function ProfilesPanel() {
  const [profiles, setProfiles] = useState<ChildProfile[]>([]),
    [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState(''),
    [preferences, setPreferences] = useState<
      (TrackPreference & { available: boolean })[]
    >([]);
  const [name, setName] = useState(''),
    [avatar, setAvatar] = useState('⭐'),
    [kind, setKind] = useState<'child' | 'adult'>('child'),
    [filter, setFilter] = useState<'favourite' | 'blocked'>('favourite'),
    [search, setSearch] = useState('');
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [currentDeviceId, setCurrentDeviceId] = useState('');
  const [independent, setIndependent] = useState(false);
  const [archivedProfiles, setArchivedProfiles] = useState<ChildProfile[]>([]),
    [approved, setApproved] = useState<ApprovedItem[]>([]),
    [collectionId, setCollectionId] = useState(''),
    [songs, setSongs] = useState<Track[]>([]),
    [trackId, setTrackId] = useState('');
  useEffect(() => {
    let active = true;
    setSongs([]);
    setTrackId('');
    if (collectionId)
      void api<Track[]>(
        `/api/admin/tracks?id=${encodeURIComponent(collectionId)}`,
      )
        .then((rows) => {
          if (active) {
            setSongs(rows);
            setTrackId(rows[0]?.id ?? '');
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [collectionId]);
  const load = useCallback(async () => {
    const data = await api<{
      profiles: ChildProfile[];
      devices: Device[];
      archivedProfiles: ChildProfile[];
      currentDeviceId: string;
      independentPlayback: boolean;
    }>('/api/admin/profiles');
    setIndependent(data.independentPlayback);
    setProfiles(data.profiles);
    setDevices(data.devices);
    setCurrentDeviceId(data.currentDeviceId);
    setArchivedProfiles(data.archivedProfiles ?? []);
    const state = await api<{ collection: ApprovedItem[] }>('/api/admin/state');
    setApproved(state.collection);
    setSelected((current) =>
      data.profiles.some((p) => p.id === current)
        ? current
        : (data.profiles[0]?.id ?? ''),
    );
  }, []);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  const loadPreferences = useCallback(async () => {
    if (selected)
      setPreferences(await api(`/api/admin/profiles/${selected}/preferences`));
  }, [selected]);
  useEffect(() => {
    setPreferences([]);
    let active = true;
    if (selected)
      void api<(TrackPreference & { available: boolean })[]>(
        `/api/admin/profiles/${selected}/preferences`,
      )
        .then((rows) => {
          if (active) setPreferences(rows);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [loadPreferences, selected]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
      await loadPreferences();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const change = (p: TrackPreference, reaction: TrackReaction) =>
    run(() =>
      send(
        `/api/admin/profiles/${selected}/preferences/${p.id}`,
        { reaction, version: p.version },
        'PUT',
      ),
    );
  const profile = profiles.find((p) => p.id === selected);
  return (
    <section className="profiles-panel">
      <ErrorNotice message={error} />
      <div className="profile-create">
        <h2>
          <Users size={23} /> Profiles
        </h2>
        <p>
          Child profiles play parent-approved music. Adult profiles can search
          and play the full Spotify and Music Assistant catalogue. Only parents
          can assign adult access to a display.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const p = await send<ChildProfile>('/api/admin/profiles', {
                name,
                avatar,
                kind,
              });
              setSelected(p.id);
              setName('');
            });
          }}
        >
          <label>
            Profile type
            <select
              aria-label="New profile type"
              value={kind}
              onChange={(e) => setKind(e.target.value as 'child' | 'adult')}
            >
              <option value="child">Child · approved music</option>
              <option value="adult">Adult · full catalogue</option>
            </select>
          </label>
          <label>
            {kind === 'adult' ? 'Adult’s name' : 'Child’s name'}
            <input
              aria-label={
                kind === 'adult' ? 'New adult name' : 'New child name'
              }
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={60}
            />
          </label>
          <label>
            Avatar
            <select
              aria-label={
                kind === 'adult' ? 'New adult avatar' : 'New child avatar'
              }
              value={avatar}
              onChange={(e) => setAvatar(e.target.value)}
            >
              {['⭐', '🌈', '🦊', '🐼', '🚀', '🐱', '🦋', '🦁'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <button className="button primary" disabled={busy}>
            {kind === 'adult' ? 'Add adult' : 'Add child'}
          </button>
        </form>
      </div>
      <div className="profile-picker" aria-label="Child profiles">
        {profiles.map((p) => (
          <button
            key={p.id}
            className={`button ${selected === p.id ? 'primary' : ''}`}
            disabled={busy}
            onClick={() => setSelected(p.id)}
          >
            {p.avatar} {p.name}
          </button>
        ))}
      </div>
      {profile && (
        <>
          <form
            key={profile.id + profile.name + profile.avatar + profile.kind}
            className="profile-edit"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void run(() =>
                send(
                  `/api/admin/profiles/${profile.id}`,
                  {
                    name: String(data.get('name')),
                    avatar: String(data.get('avatar')),
                    kind: String(data.get('kind')),
                  },
                  'PATCH',
                ),
              );
            }}
          >
            <label>
              Profile name
              <input
                name="name"
                aria-label="Profile name"
                defaultValue={profile.name}
                required
                maxLength={60}
              />
            </label>
            <label>
              Avatar
              <select
                name="avatar"
                aria-label="Profile avatar"
                defaultValue={profile.avatar}
              >
                {['⭐', '🌈', '🦊', '🐼', '🚀', '🐱', '🦋', '🦁'].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Profile type
              <select
                name="kind"
                aria-label="Profile type"
                defaultValue={profile.kind ?? 'child'}
              >
                <option value="child">Child · approved music</option>
                <option value="adult">Adult · full catalogue</option>
              </select>
            </label>
            <button className="button" disabled={busy}>
              Save profile
            </button>
            <button
              type="button"
              className="button"
              disabled={busy || profiles.length < 2}
              onClick={() => {
                if (
                  confirm(
                    `Archive ${profile.name}? Preferences will be kept and players moved to another profile.`,
                  )
                )
                  void run(() =>
                    send(`/api/admin/profiles/${profile.id}`, {}, 'DELETE'),
                  );
              }}
            >
              Archive profile
            </button>
          </form>
          <div className="parent-add-preference">
            <h3>Add from approved music</h3>
            <div className="preference-tools">
              <label>
                Collection
                <select
                  aria-label="Preference collection"
                  value={collectionId}
                  onChange={(e) => setCollectionId(e.target.value)}
                >
                  <option value="">Choose a collection</option>
                  {approved.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Song
                <select
                  aria-label="Preference song"
                  value={trackId}
                  onChange={(e) => setTrackId(e.target.value)}
                >
                  <option value="">Choose a song</option>
                  {songs.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.artist}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button"
                disabled={busy || !trackId}
                onClick={() =>
                  void run(() =>
                    send(`/api/admin/profiles/${selected}/preferences`, {
                      collectionId,
                      trackId,
                      reaction: 'favourite',
                    }),
                  )
                }
              >
                <Heart size={18} /> Add favourite
              </button>
              <button
                className="button"
                disabled={busy || !trackId}
                onClick={() =>
                  void run(() =>
                    send(`/api/admin/profiles/${selected}/preferences`, {
                      collectionId,
                      trackId,
                      reaction: 'blocked',
                    }),
                  )
                }
              >
                <ThumbsDown size={18} /> Block for this{' '}
                {profile.kind === 'adult' ? 'adult' : 'child'}
              </button>
            </div>
          </div>
          <div className="preference-tools">
            <button
              className={`button ${filter === 'favourite' ? 'primary' : ''}`}
              onClick={() => setFilter('favourite')}
            >
              <Heart size={18} /> Favourites
            </button>
            <button
              className={`button ${filter === 'blocked' ? 'primary' : ''}`}
              onClick={() => setFilter('blocked')}
            >
              <ThumbsDown size={18} /> Blocked songs
            </button>
            <label>
              Search songs
              <input
                aria-label="Search child preferences"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Title or artist"
              />
            </label>
          </div>
          <p>
            {filter === 'blocked'
              ? 'Blocks apply only to this child. The current song is allowed to finish. Unblocking does not approve or start music.'
              : 'Favourites remain stored if approval is removed, but children can only play currently approved songs.'}
          </p>
          <div className="preference-list">
            {preferences
              .filter(
                (p) =>
                  p.reaction === filter &&
                  `${p.track.name} ${p.track.artist}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
              )
              .map((p) => (
                <article key={p.id} className="preference-row">
                  <Cover src={p.track.artwork} />
                  <div>
                    <strong>{p.track.name}</strong>
                    <small>{p.track.artist}</small>
                    {!p.available && (
                      <small>Not currently available in approved music</small>
                    )}
                  </div>
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void change(p, 'neutral')}
                  >
                    {filter === 'blocked' ? 'Unblock' : 'Remove favourite'}
                  </button>
                  {filter === 'blocked' && p.available && (
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => void change(p, 'favourite')}
                    >
                      <Heart size={17} /> Favourite instead
                    </button>
                  )}
                </article>
              ))}
          </div>
          {!preferences.some((p) => p.reaction === filter) && (
            <p className="empty-preferences">
              No {filter === 'blocked' ? 'blocked songs' : 'favourites'} for{' '}
              {profile.name} yet.
            </p>
          )}
        </>
      )}
      {archivedProfiles.length > 0 && (
        <section>
          <h3>Archived profiles</h3>
          {archivedProfiles.map((p) => (
            <button
              key={p.id}
              className="button"
              disabled={busy}
              onClick={() =>
                void run(() => send(`/api/admin/profiles/${p.id}/restore`, {}))
              }
            >
              Restore {p.avatar} {p.name}
            </button>
          ))}
        </section>
      )}
      <h2>Paired players</h2>
      <p>
        Assign each player’s child here.{' '}
        {independent
          ? 'Two players can play different music independently. Release an audio slot to use a different paired device.'
          : 'Starting music on another device moves sound to that device.'}
      </p>
      {devices.map((d) => (
        <form
          key={d.id + d.revision}
          className="profile-device"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void run(() =>
              send(
                `/api/admin/profile-devices/${d.id}`,
                {
                  name: String(data.get('name')),
                  profileId: String(data.get('profileId')),
                },
                'PATCH',
              ),
            );
          }}
        >
          <label>
            Player name {d.id === currentDeviceId ? ' · This browser' : ''}
            <input
              name="name"
              defaultValue={d.name}
              aria-label={`Name ${d.name}`}
              maxLength={60}
              required
            />
          </label>
          <label>
            Child
            <select
              name="profileId"
              defaultValue={d.profileId}
              aria-label={`Child for ${d.name}`}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.avatar} {p.name}
                  {p.kind === 'adult' ? ' · Adult' : ''}
                </option>
              ))}
            </select>
          </label>
          {independent && (
            <div className="paired-player-status" role="status">
              <strong>
                {d.online ? 'Online' : 'Offline'} ·{' '}
                {d.audioAssigned ? 'Audio assigned' : 'No audio slot'}
              </strong>
              <span>
                {d.playback?.track
                  ? `${d.playback.track.name} · ${d.playback.status}`
                  : 'Ready to choose music'}
              </span>
            </div>
          )}
          <button className="button" disabled={busy}>
            Save player
          </button>
          {independent && d.audioAssigned && (
            <>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    send(`/api/admin/profile-devices/${d.id}/stop`, {}),
                  )
                }
              >
                Stop player
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    send(
                      `/api/admin/profile-devices/${d.id}/release-audio`,
                      {},
                    ),
                  )
                }
              >
                Release audio slot
              </button>
            </>
          )}
        </form>
      ))}
      {!devices.length && (
        <p>Paired players appear here when they open the child player.</p>
      )}
    </section>
  );
}
