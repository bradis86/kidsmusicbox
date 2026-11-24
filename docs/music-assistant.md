# Music Assistant setup

Use a running Music Assistant server with a configured music provider. Kids Music Box uses its catalogue and queue APIs. Keep the Music Assistant token on the server.

1. Copy `.env.example` to `.env`. Set `MUSIC_BACKEND=music-assistant`, `MA_URL`, and `MA_TOKEN`.
2. For local browser audio, choose a LAN address for `HUB_MPD_BIND_ADDRESS` that Music Assistant can reach. Set up a dedicated MPD provider in Music Assistant and use the hub address and TCP port `6600` as its discovery target. Set its stream format to MP3.
3. Start the service using the Music Assistant Compose overlay. Allow only your Music Assistant host to reach the MPD port.
4. In the hub's parent settings, choose local browser playback and the dedicated player. To preselect the target, set `MA_BROWSER_PLAYER_ID` to the actual player ID reported by your Music Assistant installation and restart the hub.

```sh
docker compose -f compose.yaml -f compose.music-assistant.yaml up --build -d
```

The hub must reach Music Assistant's API and audio stream ports. Check **Device & diagnostics** in the parent UI, then test using an approved song at a quiet volume. If the player appears available but fails to start, check the MPD target and active connections before retrying.

For two independent paired players, add a second MPD target on the next port; set `INDEPENDENT_PLAYBACK=true` and `MA_DEVICE_PLAYER_IDS` to the two IDs in port order. Use a provider dedicated to these targets so recovery cannot affect unrelated speakers. If you change the MPD port, set the second port to the first port plus one.

## HTTPS and optional integrations

Place the hub behind an HTTPS reverse proxy for trusted household devices. Set `PUBLIC_ORIGIN` to the exact external origin and `COOKIE_SECURE=true`. Allow event streams through the proxy without buffering.

Add `compose.voice.yaml` as an overlay to connect an existing speech service. It accepts the URL, API-key file and CA file from local configuration. Implement the `/readyz` and `/v1/transcribe` contract described in [the voice integration guide](voice-integration.md). See [Home Assistant integration](home-assistant.md) for optional screen automation.
