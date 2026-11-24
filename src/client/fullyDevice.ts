/** Optional Fully PLUS bridge; ordinary browsers never use device APIs. */
export interface FullyApi {
  bind(event: string, code: string): void;
  getAudioVolume(stream: number): number;
  setAudioVolume(level: number, stream: number): void;
  getScreenOn(): boolean;
  turnScreenOn(): void;
  turnScreenOff(keepAlive: boolean): void;
  setScreenBrightness?(level: number): void;
}
export interface DevicePolicy {
  canControlVolume: boolean;
  volume: number;
  maxVolume: number;
  screenOff: boolean;
  keepTouchActive?: boolean;
  screenOnBrightness?: number;
}
export class FullyDevice {
  usesNativeVolume = false;
  private disposed = false;
  private desired: number | null = null;
  private brightnessOverride = -1;
  constructor(
    private api: FullyApi,
    private policy: DevicePolicy,
    private stepVolume: (delta: number) => void,
    private error: (error: Error) => void,
  ) {
    if (!Number.isFinite(api.getAudioVolume(3)))
      throw new Error('Fully could not read the device volume');
    api.bind('volumeUp', 'window.__musicHubFully?.key(5)');
    api.bind('volumeDown', 'window.__musicHubFully?.key(-5)');
    api.bind('screenOn', 'window.__musicHubFully?.screenChanged()');
    api.bind('screenOff', 'window.__musicHubFully?.screenChanged()');
    this.volume(policy.volume);
    this.screenChanged();
  }
  update(policy: DevicePolicy) {
    if (this.disposed) return;
    const activate = !this.policy.canControlVolume && policy.canControlVolume;
    const capChanged = this.policy.maxVolume !== policy.maxVolume;
    this.policy = policy;
    if (!policy.canControlVolume) this.usesNativeVolume = false;
    if (activate || capChanged)
      this.volume(activate ? policy.volume : (this.desired ?? policy.volume));
    this.screenChanged();
  }
  volume(level: number) {
    if (this.disposed || !this.policy.canControlVolume) return;
    try {
      if (!Number.isFinite(level)) throw new Error('Invalid device volume');
      this.desired = Math.max(0, Math.min(100, this.policy.maxVolume, level));
      this.api.setAudioVolume(this.desired, 3);
      this.usesNativeVolume = true;
    } catch (error) {
      this.usesNativeVolume = false;
      this.error(error as Error);
    }
  }
  screenChanged() {
    if (this.disposed) return;
    try {
      const dim =
        this.policy.screenOff &&
        this.policy.keepTouchActive &&
        !!this.api.setScreenBrightness;
      const screenOnBrightness = this.policy.screenOff
        ? undefined
        : this.policy.screenOnBrightness;
      this.setBrightness(dim ? 0 : (screenOnBrightness ?? -1));
      const powerOff = this.policy.screenOff && !dim;
      if (powerOff && this.api.getScreenOn())
        this.api.turnScreenOff(true); // Backlight off, audio/network awake.
      else if (!powerOff && !this.api.getScreenOn()) this.api.turnScreenOn();
    } catch (error) {
      this.error(error as Error);
    }
  }
  key(delta: number) {
    if (this.disposed) return;
    try {
      if (this.policy.canControlVolume) this.stepVolume(delta);
    } catch (error) {
      this.error(error as Error);
    }
  }
  restoreBrightness() {
    this.setBrightness(-1);
  }
  private setBrightness(level: number) {
    if (!this.api.setScreenBrightness || this.brightnessOverride === level)
      return;
    this.api.setScreenBrightness(level);
    this.brightnessOverride = level;
  }
  dispose() {
    this.disposed = true;
    try {
      this.restoreBrightness();
    } catch (error) {
      this.error(error as Error);
    }
    for (const event of ['volumeUp', 'volumeDown', 'screenOn', 'screenOff'])
      this.api.bind(event, '');
  }
}
