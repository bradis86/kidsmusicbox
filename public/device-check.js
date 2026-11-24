const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const supported = types.filter((type) =>
  globalThis.MediaRecorder?.isTypeSupported(type),
);
document.querySelector('#report').textContent = JSON.stringify(
  {
    userAgent: navigator.userAgent,
    origin: location.origin,
    secureContext: isSecureContext,
    microphoneAPI: !!navigator.mediaDevices?.getUserMedia,
    supportedRecordingTypes: supported,
    hubCompatible: supported.some((type) => type.startsWith('audio/webm')),
  },
  null,
  2,
);
document.querySelector('#record').addEventListener('click', async () => {
  const result = document.querySelector('#result');
  let stream;
  try {
    const mimeType = supported.find((type) => type.startsWith('audio/webm'));
    if (!mimeType)
      throw Error(
        'This browser cannot record WebM for the voice backend. Update Safari/iOS or use editable text search in the jukebox. MP4 support alone is insufficient.',
      );
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType });
      const audio = document.querySelector('#preview');
      if (audio.src) URL.revokeObjectURL(audio.src);
      audio.src = URL.createObjectURL(blob);
      result.textContent = `Recorded ${blob.size} bytes as ${recorder.mimeType}. Tap the preview to listen locally, then test real transcription in the paired jukebox.`;
    };
    recorder.start();
    result.textContent = 'Recording for 2 seconds…';
    setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, 2000);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    result.textContent = error.message;
  }
});
