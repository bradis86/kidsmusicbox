import { useCallback, useEffect, useRef } from 'react';
import { FullyDevice, type FullyApi, type DevicePolicy } from './fullyDevice';

declare global {
  interface Window {
    fully?: FullyApi;
    __musicHubFully?: FullyDevice;
  }
}

export function useFullyDevice(
  policy: DevicePolicy | null,
  stepVolume: (delta: number) => void,
  onError: (message: string) => void,
) {
  const callbacks = useRef({ stepVolume, onError });
  callbacks.current = { stepVolume, onError };
  const instance = useRef<FullyDevice | null>(null);
  const enabled = policy !== null;
  useEffect(() => {
    const api = window.fully;
    if (!enabled || !api?.bind || !policy) return;
    try {
      const device = new FullyDevice(
        api,
        policy,
        (delta) => callbacks.current.stepVolume(delta),
        (error) => callbacks.current.onError(error.message),
      );
      window.__musicHubFully = instance.current = device;
      const beforePageHide = () => {
        try {
          device.restoreBrightness();
        } catch (error) {
          callbacks.current.onError((error as Error).message);
        }
      };
      const afterPageShow = () => device.screenChanged();
      window.addEventListener('pagehide', beforePageHide);
      window.addEventListener('pageshow', afterPageShow);
      return () => {
        window.removeEventListener('pagehide', beforePageHide);
        window.removeEventListener('pageshow', afterPageShow);
        device.dispose();
        if (window.__musicHubFully === device) delete window.__musicHubFully;
        instance.current = null;
      };
    } catch (error) {
      callbacks.current.onError((error as Error).message);
    }
    // A changing snapshot updates the existing bridge below without repeated
    // native event registrations or overwriting an optimistic slider draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  useEffect(() => {
    if (policy) instance.current?.update(policy);
  }, [policy]);
  return useCallback((volume: number) => instance.current?.volume(volume), []);
}
