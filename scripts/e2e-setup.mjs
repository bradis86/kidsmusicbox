import { mkdirSync, writeFileSync } from 'node:fs';
// Synthetic tone, never a private microphone recording or bundled music.
export default function setup() {
  mkdirSync('data', { recursive: true });
  const rate = 16000,
    samples = rate * 2,
    bytes = samples * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF');
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(
      Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 1000),
      44 + i * 2,
    );
  writeFileSync('data/e2e-microphone.wav', wav);
}
