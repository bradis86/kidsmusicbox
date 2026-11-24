import { useEffect, useRef, useState, type RefObject } from 'react';
import { Volume1, Volume2 } from 'lucide-react';
export function VolumeControl({
  value,
  max,
  disabled,
  inert,
  onVolume,
  onError,
  hardwareKeys,
  onShownVolume,
}: {
  value: number;
  max: number;
  disabled: boolean;
  inert?: boolean;
  onVolume: (volume: number) => Promise<number>;
  onError: (message: string) => void;
  hardwareKeys?: RefObject<((delta: number) => void) | null>;
  onShownVolume?: (volume: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const wanted = useRef<number | null>(null);
  const callbacks = useRef({
    onVolume,
    onError,
    value,
    max,
    disabled,
    onShownVolume,
  });
  callbacks.current = {
    onVolume,
    onError,
    value,
    max,
    disabled,
    onShownVolume,
  };
  useEffect(() => {
    if (!hardwareKeys) return;
    hardwareKeys.current = (delta) => {
      const current = callbacks.current;
      if (current.disabled) return;
      change(
        Math.max(
          0,
          Math.min(current.max, (wanted.current ?? current.value) + delta),
        ),
      );
    };
    return () => {
      hardwareKeys.current = null;
    };
    // change uses the shared queue refs and stable React setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hardwareKeys]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      pending.current = null;
    };
  }, []);
  async function flush() {
    if (running.current) return;
    running.current = true;
    try {
      while (pending.current !== null && mounted.current) {
        const target = pending.current;
        pending.current = null;
        try {
          await callbacks.current.onVolume(target);
        } catch (e) {
          if (mounted.current) callbacks.current.onError((e as Error).message);
        }
      }
    } finally {
      running.current = false;
      wanted.current = null;
      if (mounted.current) setDraft(null);
    }
  }
  function change(volume: number) {
    // Apply every key press, including one already at the cap, so a native
    // volume-key action cannot leave Android above the app's allowed level.
    callbacks.current.onShownVolume?.(volume);
    wanted.current = volume;
    setDraft(volume);
    pending.current = volume;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush();
    }, 160);
  }
  const shown = Math.min(draft ?? value, max);
  useEffect(() => {
    if (!disabled) onShownVolume?.(shown);
  }, [shown, disabled, onShownVolume]);
  return (
    <label className="volume touch-volume" inert={inert}>
      <Volume1 size={24} />
      <span className="sr-only">Volume</span>
      <input
        aria-label="Volume"
        type="range"
        min="0"
        max={max}
        value={shown}
        disabled={disabled}
        onChange={(e) => change(Number(e.target.value))}
        onPointerUp={() => {
          if (timer.current) clearTimeout(timer.current);
          timer.current = null;
          void flush();
        }}
      />
      <Volume2 size={26} />
      <output aria-label="Current volume">{shown}%</output>
    </label>
  );
}
