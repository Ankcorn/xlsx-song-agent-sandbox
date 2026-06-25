import { getSandbox, proxyToSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { generateText, tool } from "ai";
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

type DeterministicExtraction = {
  description: string;
  filename: string;
  format: string;
  tables: Array<{
    columns: string[];
    name: string;
    rows: Array<{
      cells: Record<string, string | number | boolean | null>;
      source_ref: string;
      source_row: number;
    }>;
  }>;
};

const DEFAULT_SCRIPT = [
  "from datetime import datetime",
  "numbers = [3, 5, 8, 13]",
  "print('Hello from Cloudflare Sandbox Python!')",
  "print('sum =', sum(numbers))",
  "print('utc =', datetime.utcnow().isoformat(timespec='seconds'))",
].join("\n");

const DETERMINISTIC_EXTRACTION_SCRIPT = String.raw`
import csv
import json
import os
import xml.etree.ElementTree as ET
from pathlib import Path

path = Path(SPREADSHEET_PATH)
suffix = path.suffix.lower()

def clean(value):
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value

def unique_headers(raw_headers, width):
    headers = []
    seen = {}
    for index in range(width):
        base = str(raw_headers[index]).strip() if index < len(raw_headers) and raw_headers[index] not in (None, "") else f"column_{index + 1}"
        base = base[:80] or f"column_{index + 1}"
        count = seen.get(base, 0)
        seen[base] = count + 1
        headers.append(base if count == 0 else f"{base}_{count + 1}")
    return headers

def table_from_rows(name, rows):
    if not rows:
        return {"name": name, "columns": [], "rows": []}
    width = max(len(row) for row in rows)
    headers = unique_headers(rows[0], width)
    extracted = []
    for row_index, row in enumerate(rows[1:], start=2):
        cells = {}
        empty = True
        for col_index, header in enumerate(headers):
            value = clean(row[col_index] if col_index < len(row) else None)
            if value not in (None, ""):
                empty = False
            cells[header] = value
        if not empty:
            extracted.append({"source_row": row_index, "source_ref": f"{name}!row:{row_index}", "cells": cells})
    return {"name": name, "columns": headers, "rows": extracted}

tables = []

if suffix in [".csv", ".tsv"]:
    with open(path, newline="", encoding="utf-8-sig") as handle:
        dialect = csv.excel_tab if suffix == ".tsv" else csv.excel
        rows = list(csv.reader(handle, dialect=dialect))
    tables.append(table_from_rows(path.stem, rows))
elif suffix in [".xlsx", ".xls", ".ods"]:
    import pandas as pd
    engine = "odf" if suffix == ".ods" else None
    sheets = pd.read_excel(path, sheet_name=None, header=None, engine=engine)
    for sheet_name, frame in sheets.items():
        rows = frame.where(frame.notna(), None).values.tolist()
        tables.append(table_from_rows(str(sheet_name), rows))
elif suffix == ".xml":
    tree = ET.parse(path)
    root = tree.getroot()
    rows = [["path", "attributes", "text"]]
    for element_index, element in enumerate(root.iter(), start=1):
        text = (element.text or "").strip()
        if element.attrib or text:
            rows.append([element.tag, json.dumps(element.attrib, ensure_ascii=False), text])
    tables.append(table_from_rows(root.tag or path.stem, rows))
else:
    raise ValueError(f"Unsupported file extension: {suffix}")

table_bits = []
for table in tables:
    table_bits.append(f"{table['name']}: {len(table['rows'])} rows, {len(table['columns'])} columns")

print(json.dumps({
    "description": f"{path.name} contains " + "; ".join(table_bits),
    "filename": path.name,
    "format": suffix.lstrip("."),
    "tables": tables,
}, ensure_ascii=False))
`;

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

  const requestedId = formData.get("spreadsheetId");
  const id = typeof requestedId === "string" && /^[a-f0-9-]{36}$/i.test(requestedId) ? requestedId : crypto.randomUUID();
  const agentName = agentNameForSpreadsheet(id);
  const sandboxPath = `/workspace/spreadsheets/${id}/${safeFilename(file.name)}`;
  const sandbox = getSandbox(env.Sandbox, `sandbox-${id}`);
  const fileBase64 = arrayBufferToBase64(await file.arrayBuffer());
  const stub = env.HackathonAgent.get(env.HackathonAgent.idFromName(agentName));

  await stub.fetch("https://agent.local/upload-trace", {
    body: JSON.stringify({
      detail: { filename: file.name, sizeBytes: file.size },
      spanType: "upload",
      status: "running",
      title: "Upload received",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  await sandbox.mkdir(`/workspace/spreadsheets/${id}`, { recursive: true });
  await sandbox.writeFile(sandboxPath, fileBase64, {
    encoding: "base64",
  });

  await stub.fetch("https://agent.local/upload-trace", {
    body: JSON.stringify({
      detail: { sandboxPath },
      spanType: "upload",
      status: "done",
      title: "Stored file in sandbox",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

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

  const analysisResponse = await stub.fetch("https://agent.local/analyze-spreadsheet-file", {
    body: JSON.stringify({
      filename: file.name,
      sandboxPath,
      spreadsheetId: id,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!analysisResponse.ok) throw new Error((await analysisResponse.text()) || "Failed to analyze spreadsheet file.");

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
      "The spreadsheet has also been pre-analyzed into your own Durable Object SQLite database with dynamic tables.",
      "For questions about the data, first call describe_spreadsheet_database, then query_spreadsheet_database. Use execute_python only when SQL is insufficient or the user asks for code/Python.",
      "Use pandas.read_csv for CSV, pandas.read_csv(..., sep='\\t') for TSV, pandas.read_excel for XLSX/XLS, pandas.read_excel(..., engine='odf') for ODS, and pandas.read_xml or lxml/ElementTree for XML.",
      "When citing values, include the source_ref/source_row from the generated database where possible.",
      "Keep answers concise, concrete, and useful.",
    ].join("\n");
  }

  getTools() {
    return {
      describe_spreadsheet_database: tool({
        description:
          "Describe the pre-analyzed spreadsheet database, including generated tables, columns, extraction score, and spreadsheet description.",
        inputSchema: z.object({}),
        execute: async () => this.describeAnalysisDatabase(),
      }),
      query_spreadsheet_database: tool({
        description:
          "Run a read-only SQL SELECT/WITH query against this agent's pre-analyzed spreadsheet SQLite tables. Query this before using Python.",
        inputSchema: z.object({
          sql: z.string().min(1).describe("Read-only SQLite SELECT or WITH query."),
        }),
        execute: async ({ sql }) => this.queryAnalysisDatabase(sql),
      }),
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

    if (url.pathname.endsWith("/upload-trace") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        detail?: unknown;
        spanType?: unknown;
        status?: unknown;
        title?: unknown;
      };

      if (
        typeof body.spanType !== "string" ||
        typeof body.title !== "string" ||
        (body.status !== "running" && body.status !== "done" && body.status !== "error")
      ) {
        return new Response("Invalid upload trace payload.", { status: 400 });
      }

      this.recordTrace({
        detail: body.detail,
        spanType: body.spanType,
        status: body.status,
        title: body.title,
      });
      return json({ ok: true });
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

    if (url.pathname.endsWith("/analyze-spreadsheet-file") && request.method === "POST") {
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
        return new Response("Invalid spreadsheet analysis payload.", { status: 400 });
      }

      const startedAt = Date.now();
      this.recordTrace({
        spanType: "ingestion",
        status: "running",
        title: "Pre-analysis started",
      });
      const analysis = await this.analyzeSpreadsheetFile(body.spreadsheetId, body.filename, body.sandboxPath);
      this.recordTrace({
        detail: { score: analysis.score, tables: analysis.tables },
        durationMs: Date.now() - startedAt,
        spanType: "ingestion",
        status: "done",
        title: "Pre-analysis complete",
      });
      return json(analysis);
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
    this.sql`
      CREATE TABLE IF NOT EXISTS document_analysis (
        spreadsheet_id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        deterministic_summary_json TEXT NOT NULL,
        agent_review_json TEXT NOT NULL,
        extraction_score INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS document_tables (
        spreadsheet_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        source_name TEXT NOT NULL,
        columns_json TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        PRIMARY KEY (spreadsheet_id, table_name)
      )
    `;
    this.fileSchemaReady = true;
  }

  private async analyzeSpreadsheetFile(spreadsheetId: string, filename: string, sandboxPath: string) {
    this.ensureFileSchema();
    await this.restoreSpreadsheetFile(spreadsheetId, filename, sandboxPath);

    const sandbox = getSandbox(this.env.Sandbox, `sandbox-${spreadsheetId}`);
    const result = await sandbox.exec(
      `python3 - <<'PY'\nSPREADSHEET_PATH = ${JSON.stringify(sandboxPath)}\n${DETERMINISTIC_EXTRACTION_SCRIPT}\nPY`,
      { timeout: 60_000 },
    );

    if (!result.success) {
      throw new Error(result.stderr || "Deterministic extraction failed.");
    }

    const extraction = JSON.parse(result.stdout) as DeterministicExtraction;
    this.storeDeterministicExtraction(spreadsheetId, extraction);
    const review = await this.reviewExtractionWithAgent(extraction);

    this.sql`
      INSERT INTO document_analysis (
        spreadsheet_id,
        description,
        deterministic_summary_json,
        agent_review_json,
        extraction_score,
        updated_at
      )
      VALUES (
        ${spreadsheetId},
        ${review.description},
        ${JSON.stringify(this.extractionSummary(extraction))},
        ${JSON.stringify(review)},
        ${review.score},
        ${new Date().toISOString()}
      )
      ON CONFLICT(spreadsheet_id) DO UPDATE SET
        description = excluded.description,
        deterministic_summary_json = excluded.deterministic_summary_json,
        agent_review_json = excluded.agent_review_json,
        extraction_score = excluded.extraction_score,
        updated_at = excluded.updated_at
    `;

    return { description: review.description, score: review.score, tables: extraction.tables.length };
  }

  private storeDeterministicExtraction(spreadsheetId: string, extraction: DeterministicExtraction) {
    const existingTables = this.sql<{ table_name: string }>`
      SELECT table_name FROM document_tables WHERE spreadsheet_id = ${spreadsheetId}
    `;

    for (const table of existingTables) {
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${this.quoteIdentifier(table.table_name)}`);
    }

    this.sql`DELETE FROM document_tables WHERE spreadsheet_id = ${spreadsheetId}`;
    this.sql`DELETE FROM document_analysis WHERE spreadsheet_id = ${spreadsheetId}`;

    extraction.tables.forEach((table, tableIndex) => {
      const tableName = this.safeSqlIdentifier(`doc_${tableIndex + 1}_${table.name}`);
      const uniqueColumns = this.uniqueSqlColumns(table.columns);
      const columnDefs = uniqueColumns.map((column) => `${this.quoteIdentifier(column)} TEXT`).join(", ");
      const createSql = [
        `CREATE TABLE ${this.quoteIdentifier(tableName)} (`,
        "source_row INTEGER NOT NULL,",
        "source_ref TEXT NOT NULL",
        columnDefs ? `, ${columnDefs}` : "",
        ")",
      ].join(" ");
      this.ctx.storage.sql.exec(createSql);

      for (const row of table.rows) {
        const values = uniqueColumns.map((column, index) => row.cells[table.columns[index]] ?? null);
        const insertSql = [
          `INSERT INTO ${this.quoteIdentifier(tableName)}`,
          `(${["source_row", "source_ref", ...uniqueColumns].map((column) => this.quoteIdentifier(column)).join(", ")})`,
          `VALUES (${["?", "?", ...uniqueColumns.map(() => "?")].join(", ")})`,
        ].join(" ");
        this.ctx.storage.sql.exec(insertSql, row.source_row, row.source_ref, ...values.map((value) => String(value ?? "")));
      }

      this.sql`
        INSERT INTO document_tables (spreadsheet_id, table_name, source_name, columns_json, row_count)
        VALUES (${spreadsheetId}, ${tableName}, ${table.name}, ${JSON.stringify(uniqueColumns)}, ${table.rows.length})
      `;
    });
  }

  private async reviewExtractionWithAgent(extraction: DeterministicExtraction) {
    const summary = this.extractionSummary(extraction);
    const fallback = {
      description: extraction.description,
      notes: "Agentic review was unavailable; deterministic extraction was stored and should be checked during chat.",
      risks: ["Agentic extraction review did not complete."],
      score: 70,
    };

    let resultText = "";
    try {
      const model = this.getModel();
      const result = await generateText({
        model,
        prompt: [
          "Review this deterministic spreadsheet extraction. Confirm whether it appears complete, score it from 0-100, and write a concise description of what the spreadsheet contains.",
          "The extraction should preserve all meaningful data and every row should be traceable via source_row/source_ref.",
          "Return only JSON with keys: score, description, notes, risks.",
          JSON.stringify(summary, null, 2),
        ].join("\n\n"),
        temperature: 0,
      });
      resultText = result.text;
    } catch (error) {
      this.recordTrace({
        detail: error instanceof Error ? error.message : String(error),
        spanType: "ingestion",
        status: "error",
        title: "Agentic extraction review unavailable",
      });
      return fallback;
    }

    try {
      const parsed = JSON.parse(resultText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim()) as {
        description?: unknown;
        notes?: unknown;
        risks?: unknown;
        score?: unknown;
      };
      return {
        description: typeof parsed.description === "string" ? parsed.description : fallback.description,
        notes: typeof parsed.notes === "string" ? parsed.notes : fallback.notes,
        risks: Array.isArray(parsed.risks) ? parsed.risks : fallback.risks,
        score: typeof parsed.score === "number" ? Math.max(0, Math.min(100, Math.round(parsed.score))) : fallback.score,
      };
    } catch {
      return fallback;
    }
  }

  private extractionSummary(extraction: DeterministicExtraction) {
    return {
      description: extraction.description,
      filename: extraction.filename,
      format: extraction.format,
      tables: extraction.tables.map((table) => ({
        columns: table.columns,
        name: table.name,
        row_count: table.rows.length,
        sample_rows: table.rows.slice(0, 5),
      })),
    };
  }

  private describeAnalysisDatabase() {
    this.ensureFileSchema();
    const analysis = this.sql`
      SELECT spreadsheet_id, description, extraction_score, agent_review_json, updated_at
      FROM document_analysis
      LIMIT 1
    `;
    const tables = this.sql`
      SELECT table_name, source_name, columns_json, row_count
      FROM document_tables
      ORDER BY table_name
    `;
    return { analysis, tables };
  }

  private queryAnalysisDatabase(sql: string) {
    this.ensureFileSchema();
    const trimmed = sql.trim();
    const normalized = trimmed.toLowerCase();
    if ((!normalized.startsWith("select ") && !normalized.startsWith("with ")) || normalized.includes(";")) {
      throw new Error("Only a single read-only SELECT/WITH query is allowed.");
    }

    return [...this.ctx.storage.sql.exec(trimmed)].slice(0, 200);
  }

  private safeSqlIdentifier(value: string) {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
    return cleaned && /^[a-z_]/.test(cleaned) ? cleaned : `table_${cleaned || "data"}`;
  }

  private uniqueSqlColumns(columns: string[]) {
    const seen = new Map<string, number>();
    return columns.map((column, index) => {
      const base = this.safeSqlIdentifier(column || `column_${index + 1}`);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return count === 0 ? base : `${base}_${count + 1}`;
    });
  }

  private quoteIdentifier(value: string) {
    return `"${value.replace(/"/g, '""')}"`;
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
