export type SpeechActivity = 'waiting' | 'speaking' | 'finished' | 'no-speech';

// Local level-based endpoint detection, not transcription or a wake word.
// Record from the tap so the onset check never clips the first syllable.
export class SpeechEndDetector {
  private noise = 0.002;
  private onset: number | null = null;
  private lastVoice = 0;
  private activity: SpeechActivity = 'waiting';
  constructor(private started: number) {}
  sample(rms: number, now: number): SpeechActivity {
    if (this.activity === 'finished' || this.activity === 'no-speech')
      return this.activity;
    const threshold = Math.max(0.012, this.noise * 3);
    if (this.activity === 'waiting') {
      if (rms >= threshold) {
        this.onset ??= now;
        if (now - this.onset >= 120) {
          this.activity = 'speaking';
          this.lastVoice = now;
        }
      } else {
        this.onset = null;
        this.noise = Math.min(0.008, this.noise * 0.95 + rms * 0.05);
      }
      if (this.activity === 'waiting' && now - this.started >= 5000)
        this.activity = 'no-speech';
    } else {
      if (rms >= threshold * 0.55) this.lastVoice = now;
      if (now - this.lastVoice >= 1100) this.activity = 'finished';
    }
    return this.activity;
  }
}

export interface SpeechMonitor {
  attach(stream: MediaStream): void;
  close(): void;
}

// Construct/resume directly in the tap, before awaiting microphone permission,
// so Safari can unlock this silent analysis context with the same user gesture.
export function createSpeechMonitor(
  onActivity: (activity: 'waiting' | 'speaking' | 'unavailable') => void,
  onEnd: (reason: 'finished' | 'no-speech') => void,
): SpeechMonitor | null {
  if (typeof AudioContext === 'undefined') return null;
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return null;
  }
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    source?.disconnect();
    analyser?.disconnect();
    void context.close().catch(() => {});
  };
  const unavailable = () => {
    if (closed) return;
    close();
    onActivity('unavailable');
  };
  void context.resume().catch(unavailable);
  return {
    close,
    attach(stream) {
      if (closed) return;
      try {
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        // No connection to destination: microphone audio is never played back.
        source.connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        let detector: SpeechEndDetector | null = null;
        let previous: SpeechActivity = 'waiting';
        onActivity('waiting');
        interval = setInterval(() => {
          if (closed || context.state !== 'running') return;
          try {
            const now = performance.now();
            detector ??= new SpeechEndDetector(now);
            analyser!.getFloatTimeDomainData(samples);
            let energy = 0;
            for (const sample of samples) energy += sample * sample;
            const activity = detector.sample(
              Math.sqrt(energy / samples.length),
              now,
            );
            if (activity === 'finished' || activity === 'no-speech') {
              close();
              onEnd(activity);
            } else if (activity !== previous) {
              previous = activity;
              onActivity(activity);
            }
          } catch {
            unavailable();
          }
        }, 50);
      } catch {
        unavailable();
      }
    },
  };
}
