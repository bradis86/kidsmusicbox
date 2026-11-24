import { useState } from 'react';
import { ErrorNotice } from './components';

export function AudioSample({ query }: { query: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="audio-sample">
      <audio
        aria-label="Song sample"
        controls
        autoPlay
        src={`/api/admin/sleep-music/sample?${query}`}
        onError={() => setFailed(true)}
      />
      <ErrorNotice
        message={failed ? 'This song’s audio sample could not be played.' : ''}
      />
    </div>
  );
}
