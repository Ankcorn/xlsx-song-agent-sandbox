# XLSX Song Agent Sandbox

Single Cloudflare Wrangler project using Vite, React, Cloudflare Agents, Think, Workers AI, and Cloudflare Sandbox.

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

## What is wired

- `src/worker.ts` exports `HackathonAgent` using `@cloudflare/think`.
- The agent exposes an `execute_python` tool backed by `@cloudflare/sandbox`.
- `Dockerfile` uses `docker.io/cloudflare/sandbox:0.12.1-python`.
- `wrangler.jsonc` binds Workers AI, the agent Durable Object, the Sandbox Durable Object, the container, and Vite-built static assets.
- `src/App.tsx` provides a React chat interface plus a direct sandbox smoke-test button.
