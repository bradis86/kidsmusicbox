// A short, valid PCM clip keeps iOS's native media element activated while the
// authenticated queue is prepared. A one-sample WAV may never settle play().
export function silentAudioSource() {
  const samples = 8000 / 4;
  const wav = new Uint8Array(44 + samples * 2);
  const view = new DataView(wav.buffer);
  const ascii = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) wav[at + i] = value.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, wav.length - 8, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
}

export async function audioDeadline<T>(
  operation: Promise<T>,
  message: string,
  milliseconds = 8000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
