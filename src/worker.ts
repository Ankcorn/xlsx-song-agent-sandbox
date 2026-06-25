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

type TraceInput = {
  detail?: unknown;
  durationMs?: number;
  requestId?: string;
  spanType: string;
  status: "running" | "done" | "error";
  stepNumber?: number;
  title: string;
};

type AgentTraceEvent = {
  id: string;
  request_id: string | null;
  span_type: string;
  title: string;
  status: "running" | "done" | "error";
  detail: string | null;
  step_number: number | null;
  duration_ms: number | null;
  created_at: string;
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

async function ensureSpreadsheetInSandbox(env: Env, spreadsheet: SpreadsheetRow | null | undefined) {
  if (!spreadsheet?.sandbox_path) return;

  const sandbox = getSandbox(env.Sandbox, `sandbox-${spreadsheet.id}`);
  const check = await sandbox.exec(
    `python3 - <<'PY'\nimport os\nprint('1' if os.path.exists(${JSON.stringify(spreadsheet.sandbox_path)}) else '0')\nPY`,
    { timeout: 10_000 },
  );

  if (check.stdout.trim() === "1") return;

  const stub = env.HackathonAgent.get(env.HackathonAgent.idFromName(spreadsheet.agent_name));
  const response = await stub.fetch("https://agent.local/restore-spreadsheet-file", {
    body: JSON.stringify({
      filename: spreadsheet.filename,
      sandboxPath: spreadsheet.sandbox_path,
      spreadsheetId: spreadsheet.id,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  if (!response.ok) throw new Error((await response.text()) || "Failed to restore spreadsheet file to sandbox.");
}

async function runPython(env: Env, code = DEFAULT_SCRIPT, spreadsheet?: SpreadsheetRow | null) {
  await ensureSpreadsheetInSandbox(env, spreadsheet);

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

function safeTraceDetail(detail: unknown) {
  if (detail === undefined) return null;

  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return text.length > 1800 ? `${text.slice(0, 1800)}...` : text;
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
    name.endsWith(".tsv") ||
    name.endsWith(".ods") ||
    name.endsWith(".xml")
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
    return json({ error: "Supported files: .xlsx, .xls, .csv, .tsv, .ods, .xml" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const agentName = agentNameForSpreadsheet(id);
  const sandboxPath = `/workspace/spreadsheets/${id}/${safeFilename(file.name)}`;
  const sandbox = getSandbox(env.Sandbox, `sandbox-${id}`);
  const fileBase64 = arrayBufferToBase64(await file.arrayBuffer());

  await sandbox.mkdir(`/workspace/spreadsheets/${id}`, { recursive: true });
  await sandbox.writeFile(sandboxPath, fileBase64, {
    encoding: "base64",
  });

  const stub = env.HackathonAgent.get(env.HackathonAgent.idFromName(agentName));
  const fileResponse = await stub.fetch("https://agent.local/spreadsheet-file", {
    body: JSON.stringify({
      contentType: file.type || "application/octet-stream",
      fileBase64,
      filename: file.name,
      sandboxPath,
      sizeBytes: file.size,
      spreadsheetId: id,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!fileResponse.ok) throw new Error((await fileResponse.text()) || "Failed to persist spreadsheet file.");

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
  private fileSchemaReady = false;
  private traceSchemaReady = false;
  private turnStartTimes = new Map<string, number>();

  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.7-code");
  }

  getSystemPrompt() {
    return [
      "You are a practical hackathon coding assistant.",
      "You are scoped to one uploaded spreadsheet when your agent name starts with spreadsheet-.",
      "The uploaded spreadsheet is stored on disk in that spreadsheet's Cloudflare Sandbox.",
      "When the user asks about the data, write Python for execute_python. The tool provides SPREADSHEET_PATH and SPREADSHEET_FILENAME.",
      "Use pandas.read_csv for CSV, pandas.read_csv(..., sep='\\t') for TSV, pandas.read_excel for XLSX/XLS, pandas.read_excel(..., engine='odf') for ODS, and pandas.read_xml or lxml/ElementTree for XML.",
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

  async onRequest(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/traces")) {
      return json({ traces: this.listTraces(url.searchParams.get("since")) });
    }

    if (url.pathname.endsWith("/spreadsheet-file") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        contentType?: unknown;
        fileBase64?: unknown;
        filename?: unknown;
        sandboxPath?: unknown;
        sizeBytes?: unknown;
        spreadsheetId?: unknown;
      };

      if (
        typeof body.spreadsheetId !== "string" ||
        typeof body.filename !== "string" ||
        typeof body.sandboxPath !== "string" ||
        typeof body.fileBase64 !== "string" ||
        typeof body.contentType !== "string" ||
        typeof body.sizeBytes !== "number"
      ) {
        return new Response("Invalid spreadsheet file payload.", { status: 400 });
      }

      this.storeSpreadsheetFile({
        contentType: body.contentType,
        fileBase64: body.fileBase64,
        filename: body.filename,
        sandboxPath: body.sandboxPath,
        sizeBytes: body.sizeBytes,
        spreadsheetId: body.spreadsheetId,
      });
      return json({ ok: true });
    }

    if (url.pathname.endsWith("/restore-spreadsheet-file") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        filename?: unknown;
        sandboxPath?: unknown;
        spreadsheetId?: unknown;
      };

      if (
        typeof body.spreadsheetId !== "string" ||
        typeof body.filename !== "string" ||
        typeof body.sandboxPath !== "string"
      ) {
        return new Response("Invalid spreadsheet restore payload.", { status: 400 });
      }

      await this.restoreSpreadsheetFile(body.spreadsheetId, body.filename, body.sandboxPath);
      return json({ ok: true });
    }

    return super.onRequest(request);
  }

  beforeTurn(ctx: { body?: unknown; messages?: unknown[]; requestId?: string }) {
    const turnKey = this.turnKey(ctx.requestId);
    this.turnStartTimes.set(turnKey, Date.now());
    this.recordTrace({
      detail: { messageCount: ctx.messages?.length ?? 0 },
      requestId: ctx.requestId,
      spanType: "turn",
      status: "running",
      title: "Agent turn started",
    });
  }

  beforeStep(ctx: { stepNumber?: number }) {
    this.recordTrace({
      spanType: "step",
      status: "running",
      stepNumber: ctx.stepNumber,
      title: `Step ${ctx.stepNumber ?? "?"} started`,
    });
  }

  beforeToolCall(ctx: { input?: unknown; requestId?: string; stepNumber?: number; toolName?: string }) {
    this.recordTrace({
      detail: ctx.input,
      requestId: ctx.requestId,
      spanType: "tool",
      status: "running",
      stepNumber: ctx.stepNumber,
      title: `Tool ${ctx.toolName ?? "call"} started`,
    });
  }

  afterToolCall(ctx: {
    durationMs?: number;
    error?: unknown;
    output?: unknown;
    requestId?: string;
    stepNumber?: number;
    success?: boolean;
    toolName?: string;
  }) {
    this.recordTrace({
      detail: ctx.success ? ctx.output : ctx.error,
      durationMs: ctx.durationMs,
      requestId: ctx.requestId,
      spanType: "tool",
      status: ctx.success ? "done" : "error",
      stepNumber: ctx.stepNumber,
      title: `Tool ${ctx.toolName ?? "call"} ${ctx.success ? "finished" : "failed"}`,
    });
  }

  onStepFinish(ctx: {
    finishReason?: string;
    requestId?: string;
    stepNumber?: number;
    toolCalls?: unknown[];
    usage?: unknown;
  }) {
    this.recordTrace({
      detail: {
        finishReason: ctx.finishReason,
        toolCalls: ctx.toolCalls?.length ?? 0,
        usage: ctx.usage,
      },
      requestId: ctx.requestId,
      spanType: "step",
      status: "done",
      stepNumber: ctx.stepNumber,
      title: `Step ${ctx.stepNumber ?? "?"} finished`,
    });
  }

  onChatResponse(result: { requestId?: string; status?: string }) {
    const durationMs = this.finishTurn(result.requestId);
    this.recordTrace({
      detail: result.status,
      durationMs,
      requestId: result.requestId,
      spanType: "turn",
      status: "done",
      title: "Agent turn complete",
    });
  }

  onChatError(error: unknown, ctx?: { requestId?: string; stage?: string }) {
    const durationMs = this.finishTurn(ctx?.requestId);
    this.recordTrace({
      detail: error instanceof Error ? { message: error.message, stage: ctx?.stage } : { error, stage: ctx?.stage },
      durationMs,
      requestId: ctx?.requestId,
      spanType: "turn",
      status: "error",
      title: "Agent turn failed",
    });

    return error;
  }

  private turnKey(requestId?: string) {
    return requestId ?? "__active_turn__";
  }

  private finishTurn(requestId?: string) {
    const turnKey = this.turnKey(requestId);
    const startedAt = this.turnStartTimes.get(turnKey) ?? this.turnStartTimes.get("__active_turn__");
    if (!startedAt) return;

    this.turnStartTimes.delete(turnKey);
    if (turnKey !== "__active_turn__") this.turnStartTimes.delete("__active_turn__");
    return Date.now() - startedAt;
  }

  private ensureTraceSchema() {
    if (this.traceSchemaReady) return;

    this.sql`
      CREATE TABLE IF NOT EXISTS agent_traces (
        id TEXT PRIMARY KEY,
        request_id TEXT,
        span_type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        step_number INTEGER,
        duration_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `;
    this.sql`
      CREATE INDEX IF NOT EXISTS idx_agent_traces_created_at
      ON agent_traces (created_at DESC)
    `;
    this.traceSchemaReady = true;
  }

  private ensureFileSchema() {
    if (this.fileSchemaReady) return;

    this.sql`
      CREATE TABLE IF NOT EXISTS agent_spreadsheet_files (
        spreadsheet_id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sandbox_path TEXT NOT NULL,
        file_base64 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.fileSchemaReady = true;
  }

  private storeSpreadsheetFile(input: {
    contentType: string;
    fileBase64: string;
    filename: string;
    sandboxPath: string;
    sizeBytes: number;
    spreadsheetId: string;
  }) {
    this.ensureFileSchema();
    this.sql`
      INSERT INTO agent_spreadsheet_files (
        spreadsheet_id,
        filename,
        content_type,
        size_bytes,
        sandbox_path,
        file_base64,
        updated_at
      )
      VALUES (
        ${input.spreadsheetId},
        ${input.filename},
        ${input.contentType},
        ${input.sizeBytes},
        ${input.sandboxPath},
        ${input.fileBase64},
        ${new Date().toISOString()}
      )
      ON CONFLICT(spreadsheet_id) DO UPDATE SET
        filename = excluded.filename,
        content_type = excluded.content_type,
        size_bytes = excluded.size_bytes,
        sandbox_path = excluded.sandbox_path,
        file_base64 = excluded.file_base64,
        updated_at = excluded.updated_at
    `;
  }

  private async restoreSpreadsheetFile(spreadsheetId: string, filename: string, sandboxPath: string) {
    this.ensureFileSchema();
    const rows = this.sql<{
      file_base64: string;
    }>`
      SELECT file_base64
      FROM agent_spreadsheet_files
      WHERE spreadsheet_id = ${spreadsheetId}
      LIMIT 1
    `;

    if (!rows.length) {
      throw new Error(
        [
          `The sandbox file for ${filename} is missing and this older upload has no durable agent copy to restore from.`,
          "Re-upload the spreadsheet to seed this agent's durable file store.",
        ].join(" "),
      );
    }

    const sandbox = getSandbox(this.env.Sandbox, `sandbox-${spreadsheetId}`);
    const directory = sandboxPath.slice(0, sandboxPath.lastIndexOf("/"));
    await sandbox.mkdir(directory, { recursive: true });
    await sandbox.writeFile(sandboxPath, rows[0].file_base64, {
      encoding: "base64",
    });
  }

  private listTraces(since?: string | null) {
    this.ensureTraceSchema();
    if (since) {
      return this.sql`
        SELECT id, request_id, span_type, title, status, detail, step_number, duration_ms, created_at
        FROM agent_traces
        WHERE created_at >= ${since}
        ORDER BY created_at ASC
        LIMIT 80
      `;
    }

    return this.sql`
      SELECT id, request_id, span_type, title, status, detail, step_number, duration_ms, created_at
      FROM agent_traces
      ORDER BY created_at DESC
      LIMIT 30
    `.reverse();
  }

  private recordTrace(input: TraceInput) {
    this.ensureTraceSchema();
    const trace: AgentTraceEvent = {
      id: crypto.randomUUID(),
      request_id: input.requestId ?? null,
      span_type: input.spanType,
      title: input.title,
      status: input.status,
      detail: safeTraceDetail(input.detail),
      step_number: input.stepNumber ?? null,
      duration_ms: input.durationMs ?? null,
      created_at: new Date().toISOString(),
    };

    this.sql`
      INSERT INTO agent_traces (
        id,
        request_id,
        span_type,
        title,
        status,
        detail,
        step_number,
        duration_ms,
        created_at
      )
      VALUES (
        ${trace.id},
        ${trace.request_id},
        ${trace.span_type},
        ${trace.title},
        ${trace.status},
        ${trace.detail},
        ${trace.step_number},
        ${trace.duration_ms},
        ${trace.created_at}
      )
    `;
    this.broadcast(JSON.stringify({ trace, type: "agent_trace" }));
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

    const spreadsheetTraceMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/traces$/);
    if (spreadsheetTraceMatch && request.method === "GET") {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetTraceMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });

      const id = env.HackathonAgent.idFromName(spreadsheet.agent_name);
      const stub = env.HackathonAgent.get(id);
      const traceUrl = new URL(request.url);
      traceUrl.pathname = "/traces";
      return stub.fetch(new Request(traceUrl, request));
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
