// Safari can select a playback-only category during music playback and reject
// getUserMedia in that category, before showing any microphone permission UI.
// Scope capture routing to the recording; restore it only after stopping tracks.
export function beginMicrophoneSession() {
  const session = (navigator as Navigator & { audioSession?: { type: string } })
    .audioSession;
  if (!session) return () => {};
  const previous = session.type;
  session.type = 'play-and-record';
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (session.type === 'play-and-record') session.type = previous;
  };
}
