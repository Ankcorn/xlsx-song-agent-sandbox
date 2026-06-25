# XLSX Song Agent Sandbox

Single Cloudflare Wrangler project using Vite, React, TanStack Router, Cloudflare Agents, Think, Workers AI, D1, and Cloudflare Sandbox.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173/.

The first run needs a Docker-compatible daemon, such as OrbStack or Docker Desktop, because Cloudflare Sandbox runs as a local container in development. The first container pull can take a minute.

## Smoke test

```bash
curl http://localhost:5173/api/run-python
```

Expected shape:

```json
{
  "stdout": "Hello from Cloudflare Sandbox Python!\nsum = 29\n...",
  "stderr": "",
  "exitCode": 0,
  "success": true
}
```

## Spreadsheet flow

- `/` lists uploaded spreadsheets from D1.
- `/upload` uploads `.xlsx`, `.xls`, `.csv`, or `.tsv` files and creates a D1 spreadsheet record.
- `/spreadsheets/:spreadsheetId` opens the retained chat agent for that spreadsheet.

Each spreadsheet record stores `id`, `filename`, `content_type`, `size_bytes`, `agent_name`, and `uploaded_at`. The UI passes `agent_name` to `useAgent`, which gives each spreadsheet its own durable Think agent.

## D1

Database: `xlsx-song-spreadsheets`

Apply migrations locally:

```bash
npx wrangler d1 migrations apply xlsx-song-spreadsheets --local
```

Apply migrations remotely:

```bash
npx wrangler d1 migrations apply xlsx-song-spreadsheets --remote
```

## What is wired

- `src/worker.ts` exports `HackathonAgent` using `@cloudflare/think`.
- `src/worker.ts` exposes `/api/spreadsheets` list/upload endpoints and `/api/spreadsheets/:id`.
- The agent exposes an `execute_python` tool backed by `@cloudflare/sandbox`.
- `Dockerfile` uses `docker.io/cloudflare/sandbox:0.12.1-python`.
- `wrangler.jsonc` binds Workers AI, D1, the agent Durable Object, the Sandbox Durable Object, the container, and Vite-built static assets.
- `src/App.tsx` provides TanStack Router pages for list, upload, and per-spreadsheet chat.
