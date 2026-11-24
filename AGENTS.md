# Working on Kids Music Box

Use [the development guide](docs/development.md) for local setup and [the architecture](docs/architecture.md) for the playback and data paths.

- Start in mock mode against a disposable SQLite database. Keep credentials, runtime databases, logs, exports and test artifacts outside Git.
- `src/client/` contains the child, parent and simulator views. `src/server/app.ts` contains API handlers, policy checks and playback commands. `src/server/adapters/` contains the Music Assistant and mock adapters.
- `src/server/playback-contexts.ts` manages independent renderer assignments. `src/server/browser-audio.ts` and `src/client/useBrowserAudio.ts` handle native audio and browser ownership.
- Preserve pairing, profile revision checks, parent approvals, and stream ownership. Keep child queue expansion within approved content. Never blindly retry a playback mutation after an upstream timeout.
- Preserve native buffered MP3 playback, chosen volume and mute state, parent volume caps, and Fully's native media volume and screen behavior.
- Sleep Music has a separate cutoff and can play during ordinary bedtime. Keep Stop Sleep Music beside the child footer volume slider and usable during the temporary bedtime wake window.
- Run `npm run check`, `npm run format:check` and the relevant Playwright scenarios. Independent playback has its own browser command, `npm run test:e2e:independent`.
