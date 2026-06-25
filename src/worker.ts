import { getSandbox, proxyToSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  AI: Ai;
  ASSETS: Fetcher;
  DB: D1Database;
  HackathonAgent: DurableObjectNamespace<HackathonAgent>;
  Sandbox: DurableObjectNamespace<SandboxType>;
};

type SpreadsheetRow = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  agent_name: string;
  sandbox_path: string | null;
  uploaded_at: string;
};

const DEFAULT_SCRIPT = [
  "from datetime import datetime",
  "numbers = [3, 5, 8, 13]",
  "print('Hello from Cloudflare Sandbox Python!')",
  "print('sum =', sum(numbers))",
  "print('utc =', datetime.utcnow().isoformat(timespec='seconds'))",
].join("\n");

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

async function runPython(env: Env, code = DEFAULT_SCRIPT, spreadsheet?: SpreadsheetRow | null) {
  const sandboxId = spreadsheet ? `sandbox-${spreadsheet.id}` : "hackathon-python";
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const prelude = spreadsheet?.sandbox_path
    ? [
        "import os",
        `SPREADSHEET_PATH = ${JSON.stringify(spreadsheet.sandbox_path)}`,
        `SPREADSHEET_FILENAME = ${JSON.stringify(spreadsheet.filename)}`,
        "os.environ['SPREADSHEET_PATH'] = SPREADSHEET_PATH",
        "",
      ].join("\n")
    : "";
  const result = await sandbox.exec(`python3 - <<'PY'\n${prelude}${code}\nPY`, {
    timeout: 30_000,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    success: result.success,
  };
}

function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    headers: {
      "cache-control": "no-store",
      ...init?.headers,
    },
    status: init?.status,
    statusText: init?.statusText,
  });
}

function agentNameForSpreadsheet(id: string) {
  return `spreadsheet-${id}`;
}

function spreadsheetIdFromAgentName(agentName: string) {
  return agentName.startsWith("spreadsheet-") ? agentName.slice("spreadsheet-".length) : null;
}

function safeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isSpreadsheetFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    name.endsWith(".csv") ||
    name.endsWith(".tsv")
  );
}

async function listSpreadsheets(env: Env) {
  const { results } = await env.DB.prepare(
    [
      "SELECT id, filename, content_type, size_bytes, agent_name, sandbox_path, uploaded_at",
      "FROM spreadsheets",
      "ORDER BY uploaded_at DESC",
    ].join(" "),
  ).all<SpreadsheetRow>();

  return json({ spreadsheets: results ?? [] });
}

async function getSpreadsheet(env: Env, id: string) {
  const spreadsheet = await getSpreadsheetRow(env, id);
  if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
  return json({ spreadsheet });
}

async function getSpreadsheetRow(env: Env, id: string) {
  const spreadsheet = await env.DB.prepare(
    [
      "SELECT id, filename, content_type, size_bytes, agent_name, sandbox_path, uploaded_at",
      "FROM spreadsheets",
      "WHERE id = ?",
    ].join(" "),
  )
    .bind(id)
    .first<SpreadsheetRow>();

  return spreadsheet;
}

async function uploadSpreadsheet(request: Request, env: Env) {
  const formData = await request.formData();
  const file = formData.get("spreadsheet");

  if (!(file instanceof File)) {
    return json({ error: "Upload a spreadsheet file with field name 'spreadsheet'." }, { status: 400 });
  }

  if (!isSpreadsheetFile(file)) {
    return json({ error: "Supported files: .xlsx, .xls, .csv, .tsv" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const agentName = agentNameForSpreadsheet(id);
  const sandboxPath = `/workspace/spreadsheets/${id}/${safeFilename(file.name)}`;
  const sandbox = getSandbox(env.Sandbox, `sandbox-${id}`);

  await sandbox.mkdir(`/workspace/spreadsheets/${id}`, { recursive: true });
  await sandbox.writeFile(sandboxPath, arrayBufferToBase64(await file.arrayBuffer()), {
    encoding: "base64",
  });

  await env.DB.prepare(
    [
      "INSERT INTO spreadsheets",
      "(id, filename, content_type, size_bytes, agent_name, sandbox_path)",
      "VALUES (?, ?, ?, ?, ?, ?)",
    ].join(" "),
  )
    .bind(id, file.name, file.type || "application/octet-stream", file.size, agentName, sandboxPath)
    .run();

  return json(
    {
      spreadsheet: {
        id,
        filename: file.name,
        content_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        agent_name: agentName,
        sandbox_path: sandboxPath,
      },
    },
    { status: 201 },
  );
}

export class HackathonAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.7-code");
  }

  getSystemPrompt() {
    return [
      "You are a practical hackathon coding assistant.",
      "You are scoped to one uploaded spreadsheet when your agent name starts with spreadsheet-.",
      "The uploaded spreadsheet is stored on disk in that spreadsheet's Cloudflare Sandbox.",
      "When the user asks about the data, write Python for execute_python. The tool provides SPREADSHEET_PATH and SPREADSHEET_FILENAME.",
      "Use pandas for CSV/TSV. For XLSX/XLS, try pandas.read_excel first.",
      "Keep answers concise, concrete, and useful.",
    ].join("\n");
  }

  getTools() {
    return {
      execute_python: tool({
        description:
          "Execute Python inside this spreadsheet's Cloudflare Sandbox. SPREADSHEET_PATH is available when the agent is attached to a spreadsheet.",
        inputSchema: z.object({
          code: z.string().min(1).describe("Python source code to run."),
        }),
        execute: async ({ code }) => {
          const spreadsheetId = spreadsheetIdFromAgentName(this.name);
          const spreadsheet = spreadsheetId ? await getSpreadsheetRow(this.env, spreadsheetId) : null;
          return runPython(this.env, code, spreadsheet);
        },
      }),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sandboxProxy = await proxyToSandbox(request, env);
    if (sandboxProxy) return sandboxProxy;

    const url = new URL(request.url);

    if (url.pathname === "/api/run-python") {
      let code = DEFAULT_SCRIPT;
      if (request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { code?: unknown };
        if (typeof body.code === "string" && body.code.trim()) {
          code = body.code;
        }
      }

      return Response.json(await runPython(env, code));
    }

    if (url.pathname === "/api/spreadsheets" && request.method === "GET") {
      return listSpreadsheets(env);
    }

    if (url.pathname === "/api/spreadsheets" && request.method === "POST") {
      return uploadSpreadsheet(request, env);
    }

    const spreadsheetRunMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/run-python$/);
    if (spreadsheetRunMatch && request.method === "POST") {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetRunMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
      const body = (await request.json().catch(() => ({}))) as { code?: unknown };
      const code =
        typeof body.code === "string" && body.code.trim()
          ? body.code
          : "print(open(SPREADSHEET_PATH, 'r', encoding='utf-8').read())";
      return json(await runPython(env, code, spreadsheet));
    }

    const spreadsheetMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)$/);
    if (spreadsheetMatch && request.method === "GET") {
      return getSpreadsheet(env, spreadsheetMatch[1]);
    }

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
