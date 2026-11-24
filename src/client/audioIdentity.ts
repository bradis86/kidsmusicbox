// Public renderer identity only. Authority always comes from the child session.
export function audioClientId() {
  const key = 'music-hub-native-audio-id';
  let id = localStorage.getItem(key);
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
    id = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    localStorage.setItem(key, id);
  }
  return id;
}
