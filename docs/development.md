# Development

Use Node.js 22.13 or newer and npm. The local backend uses a separate SQLite file and the demo catalogue.

```sh
npm ci
MUSIC_BACKEND=mock DATABASE_PATH=./data/development.sqlite \
  PUBLIC_ORIGIN=http://localhost:5173 HOST=127.0.0.1 npm run dev
```

Open [the local parent page](http://localhost:5173/admin) and use the first-run setup code printed by the backend.

## Checks

```sh
npm run check
npm run format:check
npx playwright install chromium
npm run test:e2e
npm run test:e2e:independent
```

Browser tests also require `ffmpeg` on the path for synthetic audio fixtures. They create their own database and run against an isolated mock backend.

## Data and deployments

Use a new Docker Compose project name or a different database path for experiments. Keep secrets in local environment files or mounted secret files. For a consistent backup, stop the app and back up the complete data volume, or use SQLite's online backup facilities. Preserve the data volume for a code-only rollback.
