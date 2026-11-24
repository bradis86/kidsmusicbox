import { expect, it } from 'vitest';
import { SpeechEndDetector } from '../src/client/speechDetection';

it('waits for speech, then ends an empty attempt without treating quiet background as speech', () => {
  const detector = new SpeechEndDetector(0);
  for (let t = 0; t < 5000; t += 50)
    expect(detector.sample(0.004, t)).toBe('waiting');
  expect(detector.sample(0.004, 5000)).toBe('no-speech');
});
it('ignores a short click instead of starting the end-of-speech timer', () => {
  const detector = new SpeechEndDetector(0);
  detector.sample(0.1, 50);
  expect(detector.sample(0.002, 100)).toBe('waiting');
  expect(detector.sample(0.002, 1600)).toBe('waiting');
});
it('detects speech immediately after the tap and finishes after 1.1 seconds of quiet', () => {
  const detector = new SpeechEndDetector(0);
  detector.sample(0.08, 0);
  expect(detector.sample(0.08, 150)).toBe('speaking');
  expect(detector.sample(0.002, 1200)).toBe('speaking');
  expect(detector.sample(0.002, 1250)).toBe('finished');
});
it('keeps listening across short gaps between words', () => {
  const detector = new SpeechEndDetector(0);
  detector.sample(0.08, 0);
  detector.sample(0.08, 150);
  expect(detector.sample(0.002, 500)).toBe('speaking');
  expect(detector.sample(0.08, 700)).toBe('speaking');
  expect(detector.sample(0.002, 1750)).toBe('speaking');
  expect(detector.sample(0.002, 1800)).toBe('finished');
});
it('accepts speech near the initial waiting deadline and does not clip it at that deadline', () => {
  const detector = new SpeechEndDetector(0);
  detector.sample(0.002, 4500);
  detector.sample(0.08, 4750);
  expect(detector.sample(0.08, 4900)).toBe('speaking');
  expect(detector.sample(0.08, 5100)).toBe('speaking');
  expect(detector.sample(0.002, 6200)).toBe('finished');
});
it('does not stop sustained input, leaving the independent recording cap in control', () => {
  const detector = new SpeechEndDetector(0);
  detector.sample(0.08, 0);
  for (let t = 150; t < 10000; t += 50)
    expect(detector.sample(0.08, t)).toBe('speaking');
});
