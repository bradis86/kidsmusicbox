import { useEffect, useRef, useState } from 'react';
import { Mic, Search, Square, X } from 'lucide-react';
import type { VoiceMatch, VoiceSearchResponse } from '../shared/types';
import { api } from './api';
import { Cover, ErrorNotice, IconButton } from './components';
import { beginMicrophoneSession } from './audioSession';
import { createSpeechMonitor, type SpeechMonitor } from './speechDetection';

export function VoiceSearch({
  disabled,
  catalogue = false,
  maxSeconds,
  duck,
  onChoose,
}: {
  disabled: boolean;
  catalogue?: boolean;
  maxSeconds: number;
  duck?: () => () => void;
  onChoose: (match: VoiceMatch) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const request = useRef<AbortController | null>(null);
  const restore = useRef<(() => void) | null>(null);
  const restoreSession = useRef<(() => void) | null>(null);
  const monitor = useRef<SpeechMonitor | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clock = useRef<ReturnType<typeof setInterval> | null>(null);
  const generation = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const [phase, setPhase] = useState<
    'idle' | 'listening' | 'searching' | 'results' | 'error'
  >('idle');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [activity, setActivity] = useState<
    'waiting' | 'speaking' | 'unavailable'
  >('waiting');
  const [result, setResult] = useState<VoiceSearchResponse | null>(null);
  const [correction, setCorrection] = useState('');
  function releaseMicrophone() {
    if (deadline.current) clearTimeout(deadline.current);
    if (clock.current) clearInterval(clock.current);
    deadline.current = clock.current = null;
    monitor.current?.close();
    monitor.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    restoreSession.current?.();
    restoreSession.current = null;
    restore.current?.();
    restore.current = null;
  }
  function cancel() {
    generation.current++;
    request.current?.abort();
    request.current = null;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
    releaseMicrophone();
  }
  function close() {
    cancel();
    dialog.current?.close();
    setPhase('idle');
    setResult(null);
    setCorrection('');
    setError('');
    opener.current?.focus();
  }
  const cleanup = useRef(cancel);
  cleanup.current = cancel;
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const hide = () => closeRef.current();
    const visibility = () => {
      if (document.hidden) hide();
    };
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', visibility);
      cleanup.current();
    };
  }, []);
  useEffect(() => {
    if (disabled) {
      cleanup.current();
      dialog.current?.close();
    }
  }, [disabled]);
  async function search(blob: Blob, current: number) {
    releaseMicrophone();
    if (current !== generation.current) return;
    setPhase('searching');
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
      60000,
    );
    try {
      const response = await api<VoiceSearchResponse>(
        '/api/child/voice/search',
        {
          method: 'POST',
          body: blob,
          headers: { 'Content-Type': blob.type },
          signal: controller.signal,
        },
      );
      if (current !== generation.current) return;
      setResult(response);
      setCorrection(response.text.slice(0, 200));
      setPhase('results');
    } catch (e) {
      if (current !== generation.current) return;
      setError((e as Error).message);
      setPhase('error');
    } finally {
      clearTimeout(timeout);
    }
  }
  async function listen() {
    cancel();
    const current = generation.current;
    setError('');
    setResult(null);
    setCorrection('');
    setSeconds(0);
    setActivity('waiting');
    try {
      if (!window.isSecureContext)
        throw Error(
          'Voice search needs a trusted HTTPS address on this device. Ask a parent to set it up.',
        );
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === 'undefined'
      )
        throw Error('This browser does not support microphone recording.');
      const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      if (!mime)
        throw Error('This browser cannot record a supported audio format.');
      setPhase('listening');
      restoreSession.current = beginMicrophoneSession();
      let noSpeech = false;
      monitor.current = createSpeechMonitor(setActivity, (reason) => {
        if (current !== generation.current) return;
        noSpeech = reason === 'no-speech';
        if (recorder.current?.state === 'recording') recorder.current.stop();
      });
      if (!monitor.current) setActivity('unavailable');
      const input = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (current !== generation.current) {
        input.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = input;
      restore.current = duck?.() ?? null;
      const capture = new MediaRecorder(input, { mimeType: mime });
      recorder.current = capture;
      const chunks: Blob[] = [];
      let total = 0;
      capture.ondataavailable = (event) => {
        if (current !== generation.current || !event.data.size) return;
        total += event.data.size;
        if (total > 5 * 1024 * 1024) {
          cancel();
          setError('That recording was too large. Try a shorter request.');
          setPhase('error');
        } else chunks.push(event.data);
      };
      capture.onerror = () => {
        if (current !== generation.current) return;
        cancel();
        setError('The microphone stopped. Please try again.');
        setPhase('error');
      };
      capture.onstop = () => {
        if (current !== generation.current) return;
        if (noSpeech) {
          chunks.length = 0;
          releaseMicrophone();
          setResult({ text: '', noSpeech: true, matches: [], partial: false });
          setPhase('results');
          return;
        }
        const blob = new Blob(chunks, { type: capture.mimeType });
        chunks.length = 0;
        if (!blob.size) {
          releaseMicrophone();
          setError('Nothing was recorded. Please try again.');
          setPhase('error');
          return;
        }
        void search(blob, current);
      };
      capture.start(250);
      monitor.current?.attach(input);
      const start = Date.now();
      clock.current = setInterval(
        () =>
          setSeconds(
            Math.min(maxSeconds, Math.floor((Date.now() - start) / 1000)),
          ),
        250,
      );
      deadline.current = setTimeout(() => {
        if (capture.state === 'recording') capture.stop();
      }, maxSeconds * 1000);
    } catch (e) {
      if (current !== generation.current) return;
      releaseMicrophone();
      setError(
        e instanceof DOMException &&
          ['NotAllowedError', 'PermissionDeniedError'].includes(e.name)
          ? 'Microphone access was denied. Ask a parent to allow it for this site.'
          : e instanceof DOMException && e.name === 'NotFoundError'
            ? 'No microphone was found on this device.'
            : (e as Error).message,
      );
      setPhase('error');
    }
  }
  async function correct() {
    cancel();
    const current = generation.current;
    setError('');
    setPhase('searching');
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await api<VoiceSearchResponse>(
        '/api/child/voice/matches',
        {
          method: 'POST',
          body: JSON.stringify({ text: correction }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20000),
          ]),
        },
      );
      if (current !== generation.current) return;
      setResult(response);
      setPhase('results');
    } catch (e) {
      if (current === generation.current) {
        setError((e as Error).message);
        setPhase('error');
      }
    }
  }
  return (
    <>
      <button
        className="voice-button"
        aria-label="Search by voice"
        disabled={disabled}
        onClick={() => {
          opener.current = document.activeElement as HTMLElement;
          dialog.current?.showModal();
          void listen();
        }}
      >
        <Mic size={23} />
      </button>
      <dialog
        className="voice-dialog"
        aria-label="Voice search"
        ref={dialog}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <header>
          <h2>
            <Mic size={24} /> Find your music
          </h2>
          <IconButton icon={X} label="Close voice search" onClick={close} />
        </header>
        <ErrorNotice message={error} />
        {phase === 'error' && (
          <form
            className="voice-correction"
            onSubmit={(event) => {
              event.preventDefault();
              void correct();
            }}
          >
            <label>
              Type a song, artist or playlist instead
              <input
                aria-label="Voice search words"
                value={correction}
                maxLength={200}
                onChange={(event) => setCorrection(event.target.value)}
              />
            </label>
            <button
              className="button"
              disabled={!correction.trim()}
              type="submit"
            >
              Search these words
            </button>
          </form>
        )}
        {phase === 'listening' && (
          <div className="voice-listening">
            <span className="voice-mic">
              <Mic size={40} />
            </span>
            <h3 role="status">Listening…</h3>
            <p>
              {activity === 'speaking'
                ? 'I hear you. Pause when you’re finished — I’ll search automatically.'
                : activity === 'unavailable'
                  ? 'Say a song, artist or playlist, then tap Search.'
                  : 'Say a song, artist or playlist. I’ll search when you finish speaking.'}
            </p>
            <small>
              {seconds} / {maxSeconds} seconds
            </small>
            <button
              className="button primary"
              onClick={() => {
                if (recorder.current?.state === 'recording')
                  recorder.current.stop();
              }}
            >
              <Square size={18} /> Search
            </button>
          </div>
        )}
        {phase === 'searching' && (
          <div className="voice-listening">
            <Search size={36} />
            <h3 role="status">Finding your music…</h3>
          </div>
        )}
        {phase === 'results' && result && (
          <>
            {result.noSpeech ? (
              <p>I didn’t hear a request. Try speaking a little closer.</p>
            ) : (
              <form
                className="voice-correction"
                onSubmit={(event) => {
                  event.preventDefault();
                  void correct();
                }}
              >
                <label>
                  I heard
                  <input
                    aria-label="Voice search words"
                    value={correction}
                    maxLength={200}
                    onChange={(event) => setCorrection(event.target.value)}
                  />
                </label>
                <button
                  className="button"
                  disabled={!correction.trim()}
                  type="submit"
                >
                  Search these words
                </button>
              </form>
            )}
            {result.partial && (
              <p className="muted">
                Some of your music could not be checked. Try again in a moment.
              </p>
            )}
            {!result.noSpeech && !result.matches.length && (
              <p>
                {catalogue
                  ? 'No matches in your music sources. Try another name or change the words above.'
                  : 'No matches on your music shelf. Try another name or change the words above.'}
              </p>
            )}
            {!!result.matches.length && (
              <>
                <p>Choose what you’d like to play.</p>
                <div className="voice-results">
                  {result.matches.map((match) => (
                    <button
                      key={`${match.collectionId}-${match.trackId ?? ''}`}
                      aria-label={`Play ${match.name}`}
                      onClick={() => {
                        close();
                        onChoose(match);
                      }}
                    >
                      <Cover src={match.artwork} alt="" />
                      <span>
                        <strong>{match.name}</strong>
                        <small>{match.artist}</small>
                        <small>
                          {match.kind === 'track'
                            ? 'Song'
                            : match.kind === 'album'
                              ? 'Album'
                              : 'Playlist'}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        <footer>
          {['results', 'error'].includes(phase) && (
            <button className="button primary" onClick={() => void listen()}>
              <Mic size={18} /> Try again
            </button>
          )}
          <button className="button" onClick={close}>
            Cancel
          </button>
          <small>
            {catalogue
              ? 'Searches your connected music sources.'
              : 'Only your approved music.'}{' '}
            Recordings aren’t saved.
          </small>
        </footer>
      </dialog>
    </>
  );
}
