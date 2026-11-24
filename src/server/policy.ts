import type { Settings } from '../shared/types.js';
export function inWindow(
  start: string,
  end: string,
  timezone: string,
  now = new Date(),
) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  return start === end
    ? false
    : start < end
      ? parts >= start && parts < end
      : parts >= start || parts < end;
}
export function policy(settings: Settings, now = new Date()) {
  const bedtime =
    settings.bedtimeEnabled &&
    inWindow(
      settings.bedtimeStart,
      settings.bedtimeEnd,
      settings.timezone,
      now,
    );
  const scheduled =
    settings.screenScheduleEnabled &&
    inWindow(settings.screenOffAt, settings.screenOnAt, settings.timezone, now);
  const screenOff =
    settings.screenOverride === 'off' ||
    (settings.screenOverride === 'auto' && scheduled);
  return {
    bedtime,
    screenOff,
    screenReason:
      settings.screenOverride === 'off'
        ? 'Parent screen control'
        : screenOff
          ? 'Night-time screen schedule'
          : 'Screen awake',
  };
}

/** Find the next local cutoff, including when a clock change skips that minute. */
export function nextClockTime(clock: string, timezone: string, now: Date) {
  const format = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const minute = 60_000;
  const start = Math.floor(now.getTime() / minute) * minute;
  const day = 24 * 60;
  const clockMinutes = (clock: string) =>
    Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const target = clockMinutes(clock);
  let previous = clockMinutes(format.format(start));
  for (
    let time = start + minute;
    time <= start + 27 * 60 * minute;
    time += minute
  ) {
    const current = clockMinutes(format.format(time));
    const advance = (current - previous + day) % day;
    const distance = (target - previous + day) % day;
    // A backward clock change looks like a nearly full day in modular time.
    if (
      current === target ||
      (advance < day / 2 && distance > 0 && distance <= advance)
    )
      return time;
    previous = current;
  }
  throw new RangeError('Could not determine the next morning cutoff');
}
