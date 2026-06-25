import { getSandbox, proxyToSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { createAiGateway } from "ai-gateway-provider";
import { createAnthropic } from "ai-gateway-provider/providers/anthropic";
import { createOpenAI } from "ai-gateway-provider/providers/openai";
import { generateText, stepCountIs, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  AI: Ai;
  AI_GATEWAY_FALLBACKS?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_MODEL?: string;
  AI_GATEWAY_PROVIDER?: string;
  ASSETS: Fetcher;
  DB: D1Database;
  HackathonAgent: DurableObjectNamespace<HackathonAgent>;
  Sandbox: DurableObjectNamespace<SandboxType>;
  SPREADSHEETS: R2Bucket;
};

type SpreadsheetRow = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  agent_name: string;
  error_message: string | null;
  r2_key: string | null;
  pre_extract: number;
  sandbox_path: string | null;
  status: "processing" | "ready" | "failed";
  updated_at: string;
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

type AgentRequestPayload = {
  agentName?: unknown;
  message?: unknown;
  spreadsheetId?: unknown;
};

type CodemodeExtraction = {
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

const CODEMODE_INSPECTION_SCRIPT = String.raw`
import json
import os
import xml.etree.ElementTree as ET
from pathlib import Path

path = Path(SPREADSHEET_PATH)
suffix = path.suffix.lower()

def clean(value):
    if value is None:
        return None
    try:
        import math
        if isinstance(value, float):
            if math.isnan(value) or math.isinf(value):
                return None
            if value.is_integer():
                return int(value)
    except Exception:
        pass
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value

def clean_matrix(rows, limit=20):
    cleaned = []
    for row in rows[:limit]:
        cleaned.append([clean(value) for value in list(row)])
    return cleaned

profile = {
    "filename": path.name,
    "extension": suffix,
    "size_bytes": path.stat().st_size,
    "sheets": [],
}

if suffix in [".csv", ".tsv"]:
    import pandas as pd
    sep = "\t" if suffix == ".tsv" else ","
    sample = pd.read_csv(path, sep=sep, header=None, nrows=20, dtype=object).where(lambda frame: frame.notna(), None)
    profile["sheets"].append({
        "name": path.stem,
        "rows_seen": int(len(sample.index)),
        "columns_seen": int(len(sample.columns)),
        "sample": clean_matrix(sample.values.tolist()),
    })
elif suffix in [".xlsx", ".xls", ".ods"]:
    import pandas as pd
    engine = "odf" if suffix == ".ods" else None
    sheets = pd.read_excel(path, sheet_name=None, header=None, engine=engine, nrows=20, dtype=object)
    for sheet_name, frame in sheets.items():
        sample = frame.where(frame.notna(), None)
        profile["sheets"].append({
            "name": str(sheet_name),
            "rows_seen": int(len(sample.index)),
            "columns_seen": int(len(sample.columns)),
            "sample": clean_matrix(sample.values.tolist()),
        })
elif suffix == ".xml":
    tree = ET.parse(path)
    root = tree.getroot()
    elements = []
    for element_index, element in enumerate(root.iter(), start=1):
        if element_index > 40:
            break
        text = (element.text or "").strip()
        if element.attrib or text:
            elements.append({"attributes": dict(element.attrib), "tag": element.tag, "text": text[:500]})
    profile["root_tag"] = root.tag
    profile["sheets"].append({
        "name": root.tag or path.stem,
        "rows_seen": len(elements),
        "columns_seen": 3,
        "sample": elements,
    })
else:
    raise ValueError(f"Unsupported file extension: {suffix}")

print(json.dumps(profile, ensure_ascii=False, allow_nan=False))
`;

const RAW_PREVIEW_SCRIPT = String.raw`
import csv
import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

path = Path(SPREADSHEET_PATH)
suffix = path.suffix.lower()

def clean(value):
    if value is None:
        return None
    try:
        if hasattr(value, "item"):
            value = value.item()
    except Exception:
        pass
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        if value.is_integer():
            return int(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value

def normalize_rows(rows, limit=100):
    return [[clean(cell) for cell in list(row)] for row in rows[:limit]]

sheets = []

if suffix in [".csv", ".tsv"]:
    with open(path, newline="", encoding="utf-8-sig") as handle:
        dialect = csv.excel_tab if suffix == ".tsv" else csv.excel
        rows = list(csv.reader(handle, dialect=dialect))
    sheets.append({"name": path.stem, "columns": max([len(row) for row in rows], default=0), "rows": normalize_rows(rows)})
elif suffix in [".xlsx", ".xls", ".ods"]:
    import pandas as pd
    engine = "odf" if suffix == ".ods" else None
    workbook = pd.read_excel(path, sheet_name=None, header=None, engine=engine, nrows=100, dtype=object)
    for name, frame in workbook.items():
        clean_frame = frame.where(frame.notna(), None)
        sheets.append({
            "name": str(name),
            "columns": int(len(clean_frame.columns)),
            "rows": normalize_rows(clean_frame.values.tolist()),
        })
elif suffix == ".xml":
    tree = ET.parse(path)
    root = tree.getroot()
    rows = [["tag", "attributes", "text"]]
    for element in root.iter():
        text = (element.text or "").strip()
        if element.attrib or text:
            rows.append([element.tag, json.dumps(element.attrib, ensure_ascii=False), text])
        if len(rows) >= 100:
            break
    sheets.append({"name": root.tag or path.stem, "columns": 3, "rows": rows})
else:
    raise ValueError(f"Unsupported file extension: {suffix}")

print(json.dumps({"format": suffix.lstrip("."), "sheets": sheets}, ensure_ascii=False, allow_nan=False))
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
      r2Key: spreadsheet.r2_key,
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

function stripCodeFence(text: string) {
  return text
    .trim()
    .replace(/^```(?:python|py)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function parseJsonText(text: string) {
  const trimmed = stripCodeFence(text);
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const jsonStart = starts.length ? Math.min(...starts) : -1;
  const jsonText = jsonStart >= 0 ? balancedJsonSlice(trimmed.slice(jsonStart)) : trimmed;
  return JSON.parse(jsonText.replace(/\b(?:NaN|Infinity|-Infinity)\b/g, "null"));
}

function parseStringArray(text: string) {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function balancedJsonSlice(text: string) {
  const opener = text[0];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : "";
  if (!closer) return text;

  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === opener) depth += 1;
    if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(0, index + 1);
    }
  }
  return text;
}

function normalizeJsonValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function normalizeCodemodeExtraction(value: unknown, filename: string): CodemodeExtraction {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawTables = Array.isArray(input.tables) ? input.tables : [];
  const tables = rawTables.map((rawTable, tableIndex) => {
    const table = rawTable && typeof rawTable === "object" ? (rawTable as Record<string, unknown>) : {};
    const rawRows = Array.isArray(table.rows) ? table.rows : [];
    const inferredColumns = new Set<string>();

    for (const rawRow of rawRows) {
      const row = rawRow && typeof rawRow === "object" ? (rawRow as Record<string, unknown>) : {};
      const cells = row.cells && typeof row.cells === "object" ? (row.cells as Record<string, unknown>) : {};
      for (const column of Object.keys(cells)) inferredColumns.add(column);
    }

    const listedColumns = Array.isArray(table.columns) ? table.columns : [];
    const columns = [...listedColumns, ...[...inferredColumns].filter((column) => !listedColumns.includes(column))]
      .map((column, columnIndex) => String(column || `column_${columnIndex + 1}`))
      .filter(Boolean);

    const rows = rawRows.map((rawRow, rowIndex) => {
      const row = rawRow && typeof rawRow === "object" ? (rawRow as Record<string, unknown>) : {};
      const cells = row.cells && typeof row.cells === "object" ? (row.cells as Record<string, unknown>) : {};
      const sourceRow = typeof row.source_row === "number" && Number.isFinite(row.source_row) ? row.source_row : rowIndex + 1;
      const normalizedCells: Record<string, string | number | boolean | null> = {};

      for (const column of columns) {
        normalizedCells[column] = normalizeJsonValue(cells[column]);
      }

      return {
        cells: normalizedCells,
        source_ref: typeof row.source_ref === "string" ? row.source_ref : `${table.name ?? `table_${tableIndex + 1}`}!row:${sourceRow}`,
        source_row: sourceRow,
      };
    });

    return {
      columns,
      name: typeof table.name === "string" && table.name.trim() ? table.name : `table_${tableIndex + 1}`,
      rows,
    };
  });

  return {
    description:
      typeof input.description === "string" && input.description.trim()
        ? input.description
        : `${filename} was analyzed in codemode into ${tables.length} table${tables.length === 1 ? "" : "s"}.`,
    filename: typeof input.filename === "string" ? input.filename : filename,
    format: typeof input.format === "string" ? input.format : filename.split(".").pop()?.toLowerCase() ?? "unknown",
    tables,
  };
}

function configuredModelEntries(env: Env) {
  const fallbackEntries = env.AI_GATEWAY_FALLBACKS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (fallbackEntries?.length) {
    return fallbackEntries.map((entry) => {
      const separator = entry.indexOf(":");
      if (separator < 1) return { model: entry, provider: env.AI_GATEWAY_PROVIDER ?? "openai" };
      return {
        model: entry.slice(separator + 1).trim(),
        provider: entry.slice(0, separator).trim(),
      };
    });
  }

  return [
    {
      model: env.AI_GATEWAY_MODEL ?? "@cf/moonshotai/kimi-k2.7-code",
      provider: env.AI_GATEWAY_PROVIDER ?? "workers-ai",
    },
  ];
}

function modelConfig(env: Env) {
  const entries = configuredModelEntries(env);
  const primary = entries[0] ?? {
    model: "@cf/moonshotai/kimi-k2.7-code",
    provider: "workers-ai",
  };

  return {
    fallbackModels: entries.slice(1),
    gatewayId: env.AI_GATEWAY_ID ?? "default",
    model: primary.model,
    provider: primary.provider,
  };
}

function providerModel(providerName: string, modelId: string) {
  const provider = providerName.toLowerCase();

  if (provider === "anthropic") return createAnthropic()(modelId);
  if (provider === "openai") return createOpenAI().chat(modelId);

  throw new Error(
    `Unsupported AI_GATEWAY_PROVIDER "${providerName}". Use workers-ai, openai, or anthropic.`,
  );
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

function r2KeyForSpreadsheet(id: string, filename: string) {
  return `spreadsheets/${id}/${safeFilename(filename)}`;
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
      "SELECT id, filename, content_type, size_bytes, agent_name, r2_key, pre_extract, sandbox_path, status, error_message, uploaded_at, updated_at",
      "FROM spreadsheets",
      "ORDER BY updated_at DESC",
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
      "SELECT id, filename, content_type, size_bytes, agent_name, r2_key, pre_extract, sandbox_path, status, error_message, uploaded_at, updated_at",
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
  const requestedPreExtract = formData.get("preExtract");
  const preExtract = requestedPreExtract !== "false";
  const id = typeof requestedId === "string" && /^[a-f0-9-]{36}$/i.test(requestedId) ? requestedId : crypto.randomUUID();
  const agentName = agentNameForSpreadsheet(id);
  const sandboxPath = `/workspace/spreadsheets/${id}/${safeFilename(file.name)}`;
  const r2Key = r2KeyForSpreadsheet(id, file.name);
  const sandbox = getSandbox(env.Sandbox, `sandbox-${id}`);
  const fileBuffer = await file.arrayBuffer();
  const stub = env.HackathonAgent.get(env.HackathonAgent.idFromName(agentName));

  await env.DB.prepare(
    [
      "INSERT INTO spreadsheets",
      "(id, filename, content_type, size_bytes, agent_name, r2_key, pre_extract, sandbox_path, status, error_message, updated_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      "ON CONFLICT(id) DO UPDATE SET",
      "filename = excluded.filename,",
      "content_type = excluded.content_type,",
      "size_bytes = excluded.size_bytes,",
      "agent_name = excluded.agent_name,",
      "r2_key = excluded.r2_key,",
      "pre_extract = excluded.pre_extract,",
      "sandbox_path = excluded.sandbox_path,",
      "status = 'processing',",
      "error_message = NULL,",
      "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    ].join(" "),
  )
    .bind(id, file.name, file.type || "application/octet-stream", file.size, agentName, r2Key, preExtract ? 1 : 0, sandboxPath)
    .run();

  await stub.fetch("https://agent.local/upload-trace", {
    body: JSON.stringify({
      detail: { filename: file.name, preExtract, sizeBytes: file.size },
      spanType: "upload",
      status: "running",
      title: "Upload received",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  let shouldDestroySandbox = false;
  try {
    await env.SPREADSHEETS.put(r2Key, fileBuffer, {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
      },
      customMetadata: {
        filename: file.name,
        spreadsheetId: id,
      },
    });

    await stub.fetch("https://agent.local/upload-trace", {
      body: JSON.stringify({
        detail: { r2Key },
        spanType: "upload",
        status: "done",
        title: "Stored file in R2",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    await sandbox.mkdir(`/workspace/spreadsheets/${id}`, { recursive: true });
    await sandbox.writeFile(sandboxPath, arrayBufferToBase64(fileBuffer), {
      encoding: "base64",
    });
    shouldDestroySandbox = true;

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
        filename: file.name,
        r2Key,
        sandboxPath,
        sizeBytes: file.size,
        spreadsheetId: id,
        preExtract,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!fileResponse.ok) throw new Error((await fileResponse.text()) || "Failed to persist spreadsheet file.");

    if (preExtract) {
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
    } else {
      await stub.fetch("https://agent.local/upload-trace", {
        body: JSON.stringify({
          detail: "File is available in R2 and the sandbox; codemode pre-extraction was skipped.",
          spanType: "ingestion",
          status: "done",
          title: "Pre-extraction skipped",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    }

    await env.DB.prepare(
      [
        "UPDATE spreadsheets",
        "SET status = 'ready', error_message = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        "WHERE id = ?",
      ].join(" "),
    )
      .bind(id)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    await env.DB.prepare(
      [
        "UPDATE spreadsheets",
        "SET status = 'failed', error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        "WHERE id = ?",
      ].join(" "),
    )
      .bind(message, id)
      .run();
    await stub.fetch("https://agent.local/upload-trace", {
      body: JSON.stringify({
        detail: message,
        spanType: "upload",
        status: "error",
        title: "Upload failed",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    throw error;
  } finally {
    if (shouldDestroySandbox) {
      await destroyUploadSandbox(sandbox, stub);
    }
  }

  return json(
    {
      spreadsheet: {
        id,
        filename: file.name,
        content_type: file.type || "application/octet-stream",
        pre_extract: preExtract ? 1 : 0,
        size_bytes: file.size,
        agent_name: agentName,
        sandbox_path: sandboxPath,
      },
    },
    { status: 201 },
  );
}

async function sendAgentRequest(request: Request, env: Env) {
  const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
  if (typeof body.message !== "string" || !body.message.trim()) {
    return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
  }

  let agentName = typeof body.agentName === "string" && body.agentName.trim() ? body.agentName.trim() : "api-agent";

  if (typeof body.spreadsheetId === "string" && body.spreadsheetId.trim()) {
    const spreadsheet = await getSpreadsheetRow(env, body.spreadsheetId.trim());
    if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
    agentName = spreadsheet.agent_name;
  }

  return sendAgentMessage(env, agentName, body.message);
}

async function sendSpreadsheetAgentRequest(request: Request, env: Env, spreadsheetId: string) {
  const spreadsheet = await getSpreadsheetRow(env, spreadsheetId);
  if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
  if (typeof body.message !== "string" || !body.message.trim()) {
    return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
  }

  return sendAgentMessage(env, spreadsheet.agent_name, body.message);
}

async function sendAgentMessage(env: Env, agentName: string, message: string) {
  const id = env.HackathonAgent.idFromName(agentName);
  const stub = env.HackathonAgent.get(id);
  const response = await stub.fetch("https://agent.local/api-request", {
    body: JSON.stringify({ message }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const data = await response
    .clone()
    .json()
    .catch(async () => ({ error: await response.text() }));
  return json(data, { status: response.status });
}

async function destroyUploadSandbox(sandbox: ReturnType<typeof getSandbox>, stub: DurableObjectStub) {
  const startedAt = Date.now();
  await stub.fetch("https://agent.local/upload-trace", {
    body: JSON.stringify({
      detail: "Releasing upload sandbox container; the spreadsheet is durable in R2 and can be restored later.",
      spanType: "upload",
      status: "running",
      title: "Releasing sandbox",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  try {
    await sandbox.destroy();
    await stub.fetch("https://agent.local/upload-trace", {
      body: JSON.stringify({
        durationMs: Date.now() - startedAt,
        spanType: "upload",
        status: "done",
        title: "Sandbox released",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    await stub.fetch("https://agent.local/upload-trace", {
      body: JSON.stringify({
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        spanType: "upload",
        status: "error",
        title: "Sandbox release failed",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }
}

export class HackathonAgent extends Think<Env> {
  private fileSchemaReady = false;
  private traceSchemaReady = false;
  private turnStartTimes = new Map<string, number>();

  getModel() {
    const entries = configuredModelEntries(this.env);
    if (entries[0]?.provider.toLowerCase() === "workers-ai") {
      return createWorkersAI({ binding: this.env.AI })(entries[0]?.model ?? "@cf/moonshotai/kimi-k2.7-code");
    }

    return this.getGatewayModel(entries);
  }

  private getGatewayModel(entries: Array<{ model: string; provider: string }>) {
    const gatewayEntries = entries.filter((entry) => entry.provider.toLowerCase() !== "workers-ai");
    if (!gatewayEntries.length) {
      throw new Error("No AI Gateway model configured.");
    }

    const gateway = createAiGateway({
      binding: this.env.AI.gateway(this.env.AI_GATEWAY_ID ?? "default"),
      options: {
        collectLog: true,
        requestTimeoutMs: 120_000,
        retries: {
          backoff: "exponential",
          maxAttempts: 3,
          retryDelayMs: 750,
        },
        skipCache: true,
      },
    });

    return gateway(gatewayEntries.map((entry) => providerModel(entry.provider, entry.model)));
  }

  getSystemPrompt() {
    const spreadsheetId = spreadsheetIdFromAgentName(this.name);
    const fileMode = spreadsheetId ? this.getSpreadsheetFileMode(spreadsheetId) : null;
    const preExtracted = fileMode?.preExtract ?? true;

    return [
      "You are a practical hackathon coding assistant.",
      "You are scoped to one uploaded spreadsheet when your agent name starts with spreadsheet-.",
      "The uploaded spreadsheet is stored on disk in that spreadsheet's Cloudflare Sandbox.",
      preExtracted
        ? "This spreadsheet was pre-extracted into your own Durable Object SQLite database with dynamic tables."
        : "This spreadsheet was uploaded without pre-extraction. Its raw file is available in the sandbox and R2, but the dynamic SQLite database may be empty.",
      preExtracted
        ? "For questions about the data, first call describe_spreadsheet_database, then query_spreadsheet_database. Use execute_python only when SQL is insufficient or the user asks for code/Python."
        : "For questions about the data, use execute_python first to inspect the raw spreadsheet file at SPREADSHEET_PATH. Do not assume pre-extracted SQL tables exist.",
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

    if (url.pathname.endsWith("/analysis-tables") && request.method === "GET") {
      return json(this.listAnalysisTables());
    }

    if (url.pathname.endsWith("/analysis-table") && request.method === "GET") {
      const tableName = url.searchParams.get("table");
      if (!tableName) return json({ error: "Missing table query parameter." }, { status: 400 });
      return json(this.getAnalysisTable(tableName));
    }

    if (url.pathname.endsWith("/raw-preview") && request.method === "GET") {
      const spreadsheetId = spreadsheetIdFromAgentName(this.name);
      if (!spreadsheetId) return json({ error: "This agent is not attached to a spreadsheet." }, { status: 400 });
      return json(await this.getRawSpreadsheetPreview(spreadsheetId));
    }

    if (url.pathname.endsWith("/api-request") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
      if (typeof body.message !== "string" || !body.message.trim()) {
        return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
      }

      const requestId = crypto.randomUUID();
      const startedAt = Date.now();
      const model = modelConfig(this.env);
      this.recordTrace({
        detail: { message: body.message, model },
        requestId,
        spanType: "api",
        status: "running",
        title: "API request received",
      });

      try {
        const result = await generateText({
          model: this.getModel(),
          prompt: body.message,
          stopWhen: stepCountIs(6),
          system: this.getSystemPrompt(),
          temperature: 0.2,
          tools: this.getTools(),
        });

        this.recordTrace({
          detail: { finishReason: result.finishReason, usage: result.usage },
          durationMs: Date.now() - startedAt,
          requestId,
          spanType: "api",
          status: "done",
          title: "API request complete",
        });

        return json({
          agentName: this.name,
          finishReason: result.finishReason,
          model,
          requestId,
          response: result.text,
          usage: result.usage,
        });
      } catch (error) {
        this.recordTrace({
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          requestId,
          spanType: "api",
          status: "error",
          title: "API request failed",
        });

        return json(
          { error: error instanceof Error ? error.message : "Agent request failed.", requestId },
          { status: 500 },
        );
      }
    }

    if (url.pathname.endsWith("/upload-trace") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        detail?: unknown;
        durationMs?: unknown;
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
        durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
        spanType: body.spanType,
        status: body.status,
        title: body.title,
      });
      return json({ ok: true });
    }

    if (url.pathname.endsWith("/spreadsheet-file") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        contentType?: unknown;
        filename?: unknown;
        preExtract?: unknown;
        r2Key?: unknown;
        sandboxPath?: unknown;
        sizeBytes?: unknown;
        spreadsheetId?: unknown;
      };

      if (
        typeof body.spreadsheetId !== "string" ||
        typeof body.filename !== "string" ||
        typeof body.sandboxPath !== "string" ||
        typeof body.r2Key !== "string" ||
        typeof body.contentType !== "string" ||
        typeof body.sizeBytes !== "number"
      ) {
        return new Response("Invalid spreadsheet file payload.", { status: 400 });
      }

      this.storeSpreadsheetFile({
        contentType: body.contentType,
        filename: body.filename,
        preExtract: body.preExtract !== false,
        r2Key: body.r2Key,
        sandboxPath: body.sandboxPath,
        sizeBytes: body.sizeBytes,
        spreadsheetId: body.spreadsheetId,
      });
      return json({ ok: true });
    }

    if (url.pathname.endsWith("/restore-spreadsheet-file") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        filename?: unknown;
        r2Key?: unknown;
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

      await this.restoreSpreadsheetFile(body.spreadsheetId, body.filename, body.sandboxPath, body.r2Key);
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
        r2_key TEXT,
        pre_extract INTEGER NOT NULL DEFAULT 1,
        file_base64 TEXT,
        updated_at TEXT NOT NULL
      )
    `;
    try {
      this.ctx.storage.sql.exec("ALTER TABLE agent_spreadsheet_files ADD COLUMN r2_key TEXT");
    } catch (error) {
      if (!(error instanceof Error ? error.message : String(error)).toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
    try {
      this.ctx.storage.sql.exec("ALTER TABLE agent_spreadsheet_files ADD COLUMN pre_extract INTEGER NOT NULL DEFAULT 1");
    } catch (error) {
      if (!(error instanceof Error ? error.message : String(error)).toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
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
    const profileResult = await sandbox.exec(
      `python3 - <<'PY'\nSPREADSHEET_PATH = ${JSON.stringify(sandboxPath)}\n${CODEMODE_INSPECTION_SCRIPT}\nPY`,
      { timeout: 60_000 },
    );

    if (!profileResult.success) {
      throw new Error(profileResult.stderr || "Codemode spreadsheet inspection failed.");
    }

    const profile = parseJsonText(profileResult.stdout);
    const code = await this.generateCodemodeExtractionCode(filename, profile);
    const extractionResult = await sandbox.exec(
      `python3 - <<'PY'\nSPREADSHEET_PATH = ${JSON.stringify(sandboxPath)}\n${code}\nPY`,
      { timeout: 120_000 },
    );

    if (!extractionResult.success) {
      throw new Error(extractionResult.stderr || "Codemode spreadsheet extraction failed.");
    }

    const extraction = normalizeCodemodeExtraction(parseJsonText(extractionResult.stdout), filename);
    this.storeCodemodeExtraction(spreadsheetId, extraction);

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
        ${extraction.description},
        ${JSON.stringify(this.extractionSummary(extraction))},
        ${JSON.stringify({ mode: "codemode", profile })},
        ${100},
        ${new Date().toISOString()}
      )
      ON CONFLICT(spreadsheet_id) DO UPDATE SET
        description = excluded.description,
        deterministic_summary_json = excluded.deterministic_summary_json,
        agent_review_json = excluded.agent_review_json,
        extraction_score = excluded.extraction_score,
        updated_at = excluded.updated_at
    `;

    return { description: extraction.description, mode: "codemode", score: 100, tables: extraction.tables.length };
  }

  private storeCodemodeExtraction(spreadsheetId: string, extraction: CodemodeExtraction) {
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

  private async generateCodemodeExtractionCode(filename: string, profile: unknown) {
    const prompt = [
      "You are in codemode. Generate a complete Python script that reads the uploaded spreadsheet at SPREADSHEET_PATH and prints one JSON object to stdout.",
      "Do not explain the code. Return only Python code, with no markdown fences.",
      "The variable SPREADSHEET_PATH is already defined as the absolute sandbox path. You must read from SPREADSHEET_PATH, not from the filename and not from the current working directory.",
      "Start by assigning path = pathlib.Path(SPREADSHEET_PATH) or Path(SPREADSHEET_PATH), and use that path variable for every file read.",
      "The script must dynamically extract the spreadsheet into this exact JSON shape:",
      '{"description": string, "filename": string, "format": string, "tables": [{"name": string, "columns": string[], "rows": [{"source_row": number, "source_ref": string, "cells": object}]}]}',
      "Rules:",
      "- Preserve all meaningful spreadsheet/XML/CSV data.",
      "- Include source_row and source_ref for every extracted row so answers can point back to the original document.",
      "- Use pandas for csv/tsv/xlsx/xls/ods when useful. Use ElementTree or lxml for XML.",
      "- Normalize NaN, Infinity, pandas.NA, timestamps, decimals, and numpy values into valid JSON values.",
      "- Print with json.dumps(..., ensure_ascii=False, allow_nan=False).",
      "- Never print Python dict reprs, comments, logs, warnings, or NaN tokens.",
      "- If the first row appears to be headers, use it as columns. Otherwise create column_1, column_2, etc.",
      `Filename: ${filename}`,
      "Inspection profile:",
      JSON.stringify(profile, null, 2),
    ].join("\n\n");

    const entries = configuredModelEntries(this.env);
    let lastError: unknown;

    for (const entry of entries) {
      const label = `${entry.provider}:${entry.model}`;
      const startedAt = Date.now();
      try {
        this.recordTrace({
          detail: label,
          spanType: "ingestion",
          status: "running",
          title: "Generating extraction code",
        });
        const model =
          entry.provider.toLowerCase() === "workers-ai"
            ? createWorkersAI({ binding: this.env.AI })(entry.model)
            : this.getGatewayModel([entry]);
        const result = await generateText({
          model,
          prompt,
          temperature: 0,
        });
        this.recordTrace({
          detail: label,
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "done",
          title: "Extraction code generated",
        });
        return stripCodeFence(result.text);
      } catch (error) {
        lastError = error;
        this.recordTrace({
          detail: error instanceof Error ? { message: error.message, model: label } : { error, model: label },
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "error",
          title: "Extraction code generation failed",
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to generate extraction code.");
  }

  private extractionSummary(extraction: CodemodeExtraction) {
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

  private listAnalysisTables() {
    this.ensureFileSchema();
    const analysis = this.sql`
      SELECT spreadsheet_id, description, extraction_score, updated_at
      FROM document_analysis
      LIMIT 1
    `;
    const tables = this.sql<{
      columns_json: string;
      row_count: number;
      source_name: string;
      table_name: string;
    }>`
      SELECT table_name, source_name, columns_json, row_count
      FROM document_tables
      ORDER BY table_name
    `.map((table) => ({
      ...table,
      columns: parseStringArray(table.columns_json),
    }));

    return { analysis: analysis[0] ?? null, tables };
  }

  private getAnalysisTable(tableName: string) {
    this.ensureFileSchema();
    const table = this.sql<{
      columns_json: string;
      row_count: number;
      source_name: string;
      table_name: string;
    }>`
      SELECT table_name, source_name, columns_json, row_count
      FROM document_tables
      WHERE table_name = ${tableName}
      LIMIT 1
    `[0];

    if (!table) return { columns: [], rows: [], table: null };

    const columns = parseStringArray(table.columns_json);
    const rows = [...this.ctx.storage.sql.exec(`SELECT * FROM ${this.quoteIdentifier(tableName)} LIMIT 200`)];
    return {
      columns: ["source_row", "source_ref", ...columns],
      rows,
      table: { ...table, columns },
    };
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

  private async getRawSpreadsheetPreview(spreadsheetId: string) {
    this.ensureFileSchema();
    const file = this.sql<{
      content_type: string;
      filename: string;
      r2_key: string | null;
      sandbox_path: string;
      size_bytes: number;
    }>`
      SELECT filename, content_type, size_bytes, sandbox_path, r2_key
      FROM agent_spreadsheet_files
      WHERE spreadsheet_id = ${spreadsheetId}
      LIMIT 1
    `[0];

    if (!file?.r2_key) throw new Error("Raw spreadsheet file is not available in R2.");

    const object = await this.env.SPREADSHEETS.get(file.r2_key);
    if (!object) throw new Error("Raw spreadsheet object was not found in R2.");

    const sandbox = getSandbox(this.env.Sandbox, `preview-${spreadsheetId}`);
    const sandboxPath = `/workspace/previews/${spreadsheetId}/${safeFilename(file.filename)}`;
    try {
      await sandbox.mkdir(`/workspace/previews/${spreadsheetId}`, { recursive: true });
      await sandbox.writeFile(sandboxPath, arrayBufferToBase64(await object.arrayBuffer()), {
        encoding: "base64",
      });
      const result = await sandbox.exec(
        `python3 - <<'PY'\nSPREADSHEET_PATH = ${JSON.stringify(sandboxPath)}\n${RAW_PREVIEW_SCRIPT}\nPY`,
        { timeout: 60_000 },
      );
      if (!result.success) throw new Error(result.stderr || "Raw spreadsheet preview failed.");
      return {
        contentType: file.content_type,
        filename: file.filename,
        preview: parseJsonText(result.stdout),
        sizeBytes: file.size_bytes,
      };
    } finally {
      await sandbox.destroy().catch(() => undefined);
    }
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
    filename: string;
    preExtract: boolean;
    r2Key: string;
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
        r2_key,
        pre_extract,
        updated_at
      )
      VALUES (
        ${input.spreadsheetId},
        ${input.filename},
        ${input.contentType},
        ${input.sizeBytes},
        ${input.sandboxPath},
        ${input.r2Key},
        ${input.preExtract ? 1 : 0},
        ${new Date().toISOString()}
      )
      ON CONFLICT(spreadsheet_id) DO UPDATE SET
        filename = excluded.filename,
        content_type = excluded.content_type,
        size_bytes = excluded.size_bytes,
        sandbox_path = excluded.sandbox_path,
        r2_key = excluded.r2_key,
        pre_extract = excluded.pre_extract,
        updated_at = excluded.updated_at
    `;
  }

  private getSpreadsheetFileMode(spreadsheetId: string) {
    this.ensureFileSchema();
    const rows = this.sql<{ pre_extract: number | null }>`
      SELECT pre_extract
      FROM agent_spreadsheet_files
      WHERE spreadsheet_id = ${spreadsheetId}
      LIMIT 1
    `;
    if (!rows[0]) return null;
    return { preExtract: rows[0].pre_extract !== 0 };
  }

  private async restoreSpreadsheetFile(spreadsheetId: string, filename: string, sandboxPath: string, r2Key?: unknown) {
    this.ensureFileSchema();
    const rows = this.sql<{
      file_base64: string | null;
      r2_key: string | null;
    }>`
      SELECT file_base64, r2_key
      FROM agent_spreadsheet_files
      WHERE spreadsheet_id = ${spreadsheetId}
      LIMIT 1
    `;

    const key = typeof r2Key === "string" ? r2Key : rows[0]?.r2_key;
    const object = key ? await this.env.SPREADSHEETS.get(key) : null;
    let fileBase64 = rows[0]?.file_base64 ?? null;

    if (object) {
      fileBase64 = arrayBufferToBase64(await object.arrayBuffer());
    }

    if (!fileBase64) {
      throw new Error(
        [
          `The sandbox file for ${filename} is missing and no R2 object was available to restore it.`,
          "Re-upload the spreadsheet to seed R2 storage.",
        ].join(" "),
      );
    }

    const sandbox = getSandbox(this.env.Sandbox, `sandbox-${spreadsheetId}`);
    const directory = sandboxPath.slice(0, sandboxPath.lastIndexOf("/"));
    await sandbox.mkdir(directory, { recursive: true });
    await sandbox.writeFile(sandboxPath, fileBase64, {
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

    if (url.pathname === "/api/agent/request" && request.method === "POST") {
      return sendAgentRequest(request, env);
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

    const spreadsheetAgentRequestMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/agent-request$/);
    if (spreadsheetAgentRequestMatch && request.method === "POST") {
      return sendSpreadsheetAgentRequest(request, env, spreadsheetAgentRequestMatch[1]);
    }

    const spreadsheetTablesMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/tables$/);
    if (spreadsheetTablesMatch && request.method === "GET") {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetTablesMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
      const stub = env.HackathonAgent.get(env.HackathonAgent.idFromName(spreadsheet.agent_name));
      return stub.fetch("https://agent.local/analysis-tables");
    }

    const spreadsheetTableMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/tables\/([^/]+)$/);
    if (spreadsheetTableMatch && request.method === "GET") {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetTableMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
      const tableUrl = new URL("https://agent.local/analysis-table");
      tableUrl.searchParams.set("table", decodeURIComponent(spreadsheetTableMatch[2]));
      const stub = env.HackathonAgent.get(env.HackathonAgent.idFromName(spreadsheet.agent_name));
      return stub.fetch(tableUrl);
    }

    const spreadsheetRawPreviewMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/raw-preview$/);
    if (spreadsheetRawPreviewMatch && request.method === "GET") {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetRawPreviewMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
      const stub = env.HackathonAgent.get(env.HackathonAgent.idFromName(spreadsheet.agent_name));
      return stub.fetch("https://agent.local/raw-preview");
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
