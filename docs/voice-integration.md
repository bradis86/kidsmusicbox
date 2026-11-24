# Optional voice search

Voice search records when the child taps the microphone. The hub sends that short recording to a speech service configured by the operator, then matches the transcript using the current profile's catalogue permissions. The child selects a result to start playback. Browsers need microphone permission and a secure context.

## Connect a speech service

Supply `VOICE_STT_URL`, `VOICE_STT_API_KEY_FILE`, and `VOICE_STT_CA_FILE` through local configuration. The [Compose overlay](../compose.voice.yaml) mounts the key and CA files read-only. The hub uses HTTPS and sends the key as an authorization bearer token.

- `GET /readyz` returns a JSON object. It may include `model` and `device` strings for diagnostics.
- `POST /v1/transcribe` accepts multipart fields `language` (currently `en`) and `file` (WAV or WebM). It returns `api_version: 1`, `text`, `language: "en"`, `no_speech`, and `audio_duration_ms`.

Enable voice search in the parent settings and check the voice status in device diagnostics. This repository includes the hub integration and an isolated test fixture. Run the speech service separately and set its retention policy for your household.
