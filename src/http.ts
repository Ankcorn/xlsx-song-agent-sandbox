import { getSandbox, proxyToSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { createAiGateway } from "ai-gateway-provider";
import { createAnthropic } from "ai-gateway-provider/providers/anthropic";
import { createOpenAI } from "ai-gateway-provider/providers/openai";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
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
  EXTRACTION_WORKFLOW: Workflow;
  HackathonAgent: DurableObjectNamespace<SheetsThink>;
  SheetsThink: DurableObjectNamespace<SheetsThink>;
  AgentThink: DurableObjectNamespace<AgentThink>;
  Sandbox: DurableObjectNamespace<SandboxType>;
  SPREADSHEETS: R2Bucket;
};

type SpreadsheetRow = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  agent_name: string;
  category: string;
  error_message: string | null;
  r2_key: string | null;
  pre_extract: number;
  sandbox_path: string | null;
  status: "processing" | "ready" | "failed";
  updated_at: string;
  uploaded_at: string;
};

type SpreadsheetRevisionRow = {
  id: string;
  spreadsheet_id: string;
  revision_number: number;
  action: "upload" | "revision_upload";
  filename: string;
  r2_key: string;
  size_bytes: number;
  content_type: string;
  summary: string | null;
  created_at: string;
};

type LibraryAgentRow = {
  id: string;
  name: string;
  description: string;
  agent_name: string;
  status: "ready" | "processing" | "failed";
  error_message: string | null;
  created_at: string;
  updated_at: string;
  sheet_count?: number;
};

type LibraryAgentSheetRow = SpreadsheetRow & {
  attached_at: string;
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

type SpreadsheetSearchCandidate = {
  columns: string[];
  description: string | null;
  filename: string;
  id: string;
  rowCount: number;
  status: string;
  tables: Array<{
    columns: string[];
    name: string;
    rowCount: number;
    sourceName: string;
  }>;
  updatedAt: string;
};

type CreateLibraryAgentPayload = {
  description?: unknown;
  name?: unknown;
  spreadsheetIds?: unknown;
};

type AgentInitializationPayload = {
  agentId: string;
  description: string;
  name: string;
  sheets: Array<{
    analysis: {
      description: string;
      extraction_score: number;
      spreadsheet_id: string;
      updated_at: string;
    } | null;
    category: string;
    filename: string;
    metadata?: Record<string, unknown> | null;
    spreadsheetId: string;
    tables: Array<{
      columns: string[];
      rows: Record<string, unknown>[];
      sourceName: string;
      tableName: string;
    }>;
  }>;
};

type ExtractionWorkflowParams = {
  agentName: string;
  contentType: string;
  filename: string;
  r2Key: string;
  sandboxPath: string;
  sizeBytes: number;
  spreadsheetId: string;
};

type CodemodeExtraction = {
  description: string;
  filename: string;
  format: string;
  metadata: {
    category: string;
    confidence_score: number;
    caveats: string;
    description: string;
    dimensions: Record<string, unknown>;
    domain: string;
    extraction_notes: string;
    geography: string;
    measures: Record<string, unknown>;
    source_summary: string;
    time_period: string;
    title: string;
    units: string;
  };
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

def sniff_delimiter(path, fallback):
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        sample = handle.read(65536)
    if not sample.strip():
        return fallback
    try:
        return csv.Sniffer().sniff(sample, delimiters=[",", "\t", ";", "|"]).delimiter
    except Exception:
        return fallback

def inspect_delimited(path, suffix):
    import pandas as pd
    sep = "\t" if suffix == ".tsv" else sniff_delimiter(path, ",")
    try:
        return (
            pd.read_csv(
                path,
                sep=sep,
                header=None,
                nrows=20,
                dtype=object,
                engine="python",
                on_bad_lines="skip",
                encoding="utf-8-sig",
            ).where(lambda frame: frame.notna(), None),
            sep,
            "pandas-python",
        )
    except Exception as pandas_error:
        rows = []
        with open(path, newline="", encoding="utf-8-sig", errors="replace") as handle:
            reader = csv.reader(handle, delimiter=sep)
            for row_index, row in enumerate(reader):
                if row_index >= 20:
                    break
                rows.append(row)
        max_columns = max([len(row) for row in rows], default=0)
        normalized = [row + [None] * (max_columns - len(row)) for row in rows]
        return pd.DataFrame(normalized, dtype=object), sep, f"csv-reader fallback after {type(pandas_error).__name__}"

profile = {
    "filename": path.name,
    "extension": suffix,
    "size_bytes": path.stat().st_size,
    "sheets": [],
}

if suffix in [".csv", ".tsv"]:
    sample, delimiter, parser = inspect_delimited(path, suffix)
    profile["sheets"].append({
        "name": path.stem,
        "rows_seen": int(len(sample.index)),
        "columns_seen": int(len(sample.columns)),
        "delimiter": delimiter,
        "parser": parser,
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

  const stub = env.SheetsThink.get(env.SheetsThink.idFromName(spreadsheet.agent_name));
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
  const metadataInput = input.metadata && typeof input.metadata === "object" ? (input.metadata as Record<string, unknown>) : {};
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

  const description =
      typeof input.description === "string" && input.description.trim()
        ? input.description
        : typeof metadataInput.description === "string" && metadataInput.description.trim()
          ? metadataInput.description
          : `${filename} was analyzed in codemode into ${tables.length} table${tables.length === 1 ? "" : "s"}.`;
  const metadata = {
    category: typeof metadataInput.category === "string" && metadataInput.category.trim() ? metadataInput.category : "Uncategorised",
    caveats: typeof metadataInput.caveats === "string" ? metadataInput.caveats : "",
    confidence_score:
      typeof metadataInput.confidence_score === "number" && Number.isFinite(metadataInput.confidence_score)
        ? Math.max(0, Math.min(100, Math.round(metadataInput.confidence_score)))
        : 75,
    description,
    dimensions:
      metadataInput.dimensions && typeof metadataInput.dimensions === "object"
        ? (metadataInput.dimensions as Record<string, unknown>)
        : {},
    domain: typeof metadataInput.domain === "string" && metadataInput.domain.trim() ? metadataInput.domain : "general",
    extraction_notes: typeof metadataInput.extraction_notes === "string" ? metadataInput.extraction_notes : "",
    geography: typeof metadataInput.geography === "string" ? metadataInput.geography : "",
    measures:
      metadataInput.measures && typeof metadataInput.measures === "object"
        ? (metadataInput.measures as Record<string, unknown>)
        : {},
    source_summary: typeof metadataInput.source_summary === "string" ? metadataInput.source_summary : "",
    time_period: typeof metadataInput.time_period === "string" ? metadataInput.time_period : "",
    title:
      typeof metadataInput.title === "string" && metadataInput.title.trim()
        ? metadataInput.title
        : filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
    units: typeof metadataInput.units === "string" ? metadataInput.units : "",
  };

  return {
    description,
    filename: typeof input.filename === "string" ? input.filename : filename,
    format: typeof input.format === "string" ? input.format : filename.split(".").pop()?.toLowerCase() ?? "unknown",
    metadata,
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
      model: env.AI_GATEWAY_MODEL ?? "gpt-5.5",
      provider: env.AI_GATEWAY_PROVIDER ?? "openai",
    },
  ];
}

function modelConfig(env: Env) {
  const entries = configuredModelEntries(env);
  const primary = entries[0] ?? {
    model: "gpt-5.5",
    provider: "openai",
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

function modelForEnv(env: Env) {
  const entries = configuredModelEntries(env);
  if (entries[0]?.provider.toLowerCase() === "workers-ai") {
    return createWorkersAI({ binding: env.AI })(entries[0]?.model ?? "@cf/moonshotai/kimi-k2.7-code");
  }

  const gatewayEntries = entries.filter((entry) => entry.provider.toLowerCase() !== "workers-ai");
  if (!gatewayEntries.length) throw new Error("No AI Gateway model configured.");

  const gateway = createAiGateway({
    binding: env.AI.gateway(env.AI_GATEWAY_ID ?? "default"),
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

function agentNameForSpreadsheet(id: string) {
  return `spreadsheet-${id}`;
}

function agentNameForLibraryAgent(id: string) {
  return `agent-${id}`;
}

function spreadsheetIdFromAgentName(agentName: string) {
  return agentName.startsWith("spreadsheet-") ? agentName.slice("spreadsheet-".length) : null;
}

function libraryAgentIdFromAgentName(agentName: string) {
  return agentName.startsWith("agent-") ? agentName.slice("agent-".length) : null;
}

function cleanCategory(value: unknown) {
  if (typeof value !== "string") return "Uncategorised";
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 80) : "Uncategorised";
}

function safeTraceDetail(detail: unknown) {
  if (detail === undefined) return null;

  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return text.length > 2400 ? `${text.slice(0, 2400)}...` : text;
}

function traceSnippet(value: unknown, limit = 900) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function traceDetail(summary: string, snippet?: unknown) {
  return {
    snippet: snippet === undefined ? undefined : traceSnippet(snippet),
    summary,
  };
}

function profileSummary(profile: unknown) {
  if (typeof profile !== "object" || profile === null) return profile;
  const record = profile as {
    extension?: unknown;
    filename?: unknown;
    sheets?: unknown;
    size_bytes?: unknown;
  };
  const sheets = Array.isArray(record.sheets)
    ? record.sheets.map((sheet) => {
        if (typeof sheet !== "object" || sheet === null) return sheet;
        const typedSheet = sheet as {
          columns_seen?: unknown;
          delimiter?: unknown;
          name?: unknown;
          parser?: unknown;
          rows_seen?: unknown;
        };
        return {
          columns_seen: typedSheet.columns_seen,
          delimiter: typedSheet.delimiter,
          name: typedSheet.name,
          parser: typedSheet.parser,
          rows_seen: typedSheet.rows_seen,
        };
      })
    : [];
  return {
    extension: record.extension,
    filename: record.filename,
    sheets,
    size_bytes: record.size_bytes,
  };
}

function extractionTableSummary(extraction: CodemodeExtraction) {
  return extraction.tables.map((table) => ({
    columns: table.columns.slice(0, 12),
    name: table.name,
    row_count: table.rows.length,
  }));
}

function safeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function r2KeyForSpreadsheet(id: string, filename: string) {
  return `spreadsheets/${id}/${safeFilename(filename)}`;
}

function revisionR2KeyForSpreadsheet(id: string, revisionNumber: number, filename: string) {
  return `spreadsheets/${id}/revisions/${revisionNumber}/${safeFilename(filename)}`;
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

function extractionNotReadyResponse(spreadsheet: SpreadsheetRow) {
  if (spreadsheet.pre_extract !== 1 || spreadsheet.status === "ready") return null;

  const message =
    spreadsheet.status === "failed"
      ? `Pre-extraction failed for ${spreadsheet.filename}: ${spreadsheet.error_message ?? "unknown error"}`
      : `Pre-extraction is still ${spreadsheet.status} for ${spreadsheet.filename}. Retry this request when the spreadsheet status is ready.`;

  return json(
    {
      error: message,
      spreadsheetId: spreadsheet.id,
      status: spreadsheet.status,
    },
    { status: spreadsheet.status === "failed" ? 409 : 425 },
  );
}

async function listSpreadsheets(env: Env) {
  const { results } = await env.DB.prepare(
    [
      "SELECT id, filename, content_type, size_bytes, agent_name, category, r2_key, pre_extract, sandbox_path, status, error_message, uploaded_at, updated_at",
      "FROM spreadsheets",
      "ORDER BY category ASC, updated_at DESC",
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
      "SELECT id, filename, content_type, size_bytes, agent_name, category, r2_key, pre_extract, sandbox_path, status, error_message, uploaded_at, updated_at",
      "FROM spreadsheets",
      "WHERE id = ?",
    ].join(" "),
  )
    .bind(id)
    .first<SpreadsheetRow>();

  return spreadsheet;
}

async function nextSpreadsheetRevisionNumber(env: Env, spreadsheetId: string) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision_number FROM spreadsheet_revisions WHERE spreadsheet_id = ?",
  )
    .bind(spreadsheetId)
    .first<{ revision_number: number }>();

  return row?.revision_number ?? 1;
}

async function listSpreadsheetRevisionRows(env: Env, spreadsheetId: string) {
  const { results } = await env.DB.prepare(
    [
      "SELECT id, spreadsheet_id, revision_number, action, filename, r2_key, size_bytes, content_type, summary, created_at",
      "FROM spreadsheet_revisions",
      "WHERE spreadsheet_id = ?",
      "ORDER BY revision_number DESC",
    ].join(" "),
  )
    .bind(spreadsheetId)
    .all<SpreadsheetRevisionRow>();

  return results ?? [];
}

async function listSpreadsheetRevisions(env: Env, spreadsheetId: string) {
  const spreadsheet = await getSpreadsheetRow(env, spreadsheetId);
  if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
  const revisions = await listSpreadsheetRevisionRows(env, spreadsheetId);
  return json({ revisions, spreadsheet });
}

async function recordSpreadsheetRevision(
  env: Env,
  input: {
    action: SpreadsheetRevisionRow["action"];
    contentType: string;
    filename: string;
    r2Key: string;
    revisionNumber: number;
    sizeBytes: number;
    spreadsheetId: string;
    summary: string;
  },
) {
  const revisionId = crypto.randomUUID();
  await env.DB.prepare(
    [
      "INSERT INTO spreadsheet_revisions",
      "(id, spreadsheet_id, revision_number, action, filename, r2_key, size_bytes, content_type, summary)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ].join(" "),
  )
    .bind(
      revisionId,
      input.spreadsheetId,
      input.revisionNumber,
      input.action,
      input.filename,
      input.r2Key,
      input.sizeBytes,
      input.contentType,
      input.summary,
    )
    .run();

  return env.DB.prepare(
    [
      "SELECT id, spreadsheet_id, revision_number, action, filename, r2_key, size_bytes, content_type, summary, created_at",
      "FROM spreadsheet_revisions",
      "WHERE id = ?",
    ].join(" "),
  )
    .bind(revisionId)
    .first<SpreadsheetRevisionRow>();
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
  const category = cleanCategory(formData.get("category"));
  const preExtract = requestedPreExtract !== "false";
  const id = typeof requestedId === "string" && /^[a-f0-9-]{36}$/i.test(requestedId) ? requestedId : crypto.randomUUID();
  const existingSpreadsheet = await getSpreadsheetRow(env, id);
  const revisionNumber = await nextSpreadsheetRevisionNumber(env, id);
  const agentName = agentNameForSpreadsheet(id);
  const sandboxPath = `/workspace/spreadsheets/${id}/${safeFilename(file.name)}`;
  const r2Key = revisionR2KeyForSpreadsheet(id, revisionNumber, file.name);
  const sandbox = getSandbox(env.Sandbox, `sandbox-${id}`);
  const fileBuffer = await file.arrayBuffer();
  const stub = env.SheetsThink.get(env.SheetsThink.idFromName(agentName));
  let revision: SpreadsheetRevisionRow | null = null;

  await env.DB.prepare(
    [
      "INSERT INTO spreadsheets",
      "(id, filename, content_type, size_bytes, agent_name, category, r2_key, pre_extract, sandbox_path, status, error_message, updated_at)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
      "ON CONFLICT(id) DO UPDATE SET",
      "filename = excluded.filename,",
      "content_type = excluded.content_type,",
      "size_bytes = excluded.size_bytes,",
      "agent_name = excluded.agent_name,",
      "category = excluded.category,",
      "r2_key = excluded.r2_key,",
      "pre_extract = excluded.pre_extract,",
      "sandbox_path = excluded.sandbox_path,",
      "status = 'processing',",
      "error_message = NULL,",
      "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    ].join(" "),
  )
    .bind(id, file.name, file.type || "application/octet-stream", file.size, agentName, category, r2Key, preExtract ? 1 : 0, sandboxPath)
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
        revisionNumber: String(revisionNumber),
        spreadsheetId: id,
      },
    });

    revision = await recordSpreadsheetRevision(env, {
      action: existingSpreadsheet ? "revision_upload" : "upload",
      contentType: file.type || "application/octet-stream",
      filename: file.name,
      r2Key,
      revisionNumber,
      sizeBytes: file.size,
      spreadsheetId: id,
      summary: existingSpreadsheet
        ? `Revision ${revisionNumber} uploaded as ${file.name}. Previous latest file was ${existingSpreadsheet.filename}.`
        : `Initial upload of ${file.name}.`,
    });

    await stub.fetch("https://agent.local/upload-trace", {
      body: JSON.stringify({
        detail: { r2Key, revisionNumber },
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
        revisionNumber,
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
      await stub.fetch("https://agent.local/upload-trace", {
        body: JSON.stringify({
          detail: "Codemode pre-extraction is running in a Cloudflare Workflow.",
          spanType: "workflow",
          status: "running",
          title: "Extraction workflow queued",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const spreadsheet = await getSpreadsheetRow(env, id);
      if (!spreadsheet) throw new Error("Failed to load spreadsheet for extraction workflow.");
      const workflowId = await startExtractionWorkflow(env, spreadsheet);
      await stub.fetch("https://agent.local/upload-trace", {
        body: JSON.stringify({
          detail: { workflowId },
          spanType: "workflow",
          status: "done",
          title: "Extraction workflow started",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
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

      await env.DB.prepare(
        [
          "UPDATE spreadsheets",
          "SET status = 'ready', error_message = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
          "WHERE id = ?",
        ].join(" "),
      )
        .bind(id)
        .run();
    }
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
        category,
        pre_extract: preExtract ? 1 : 0,
        size_bytes: file.size,
        agent_name: agentName,
        revision,
        sandbox_path: sandboxPath,
      },
    },
    { status: 201 },
  );
}

async function uploadSpreadsheetRevision(request: Request, env: Env, spreadsheetId: string) {
  const existingSpreadsheet = await getSpreadsheetRow(env, spreadsheetId);
  if (!existingSpreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });

  const formData = await request.formData();
  const file = formData.get("spreadsheet");

  if (!(file instanceof File)) {
    return json({ error: "Upload a spreadsheet file with field name 'spreadsheet'." }, { status: 400 });
  }

  if (!isSpreadsheetFile(file)) {
    return json({ error: "Supported files: .xlsx, .xls, .csv, .tsv, .ods, .xml" }, { status: 400 });
  }

  const requestedPreExtract = formData.get("preExtract");
  const preExtract = requestedPreExtract !== "false";
  const revisionNumber = await nextSpreadsheetRevisionNumber(env, spreadsheetId);
  const sandboxPath = `/workspace/spreadsheets/${spreadsheetId}/${safeFilename(file.name)}`;
  const r2Key = revisionR2KeyForSpreadsheet(spreadsheetId, revisionNumber, file.name);
  const sandbox = getSandbox(env.Sandbox, `sandbox-${spreadsheetId}`);
  const fileBuffer = await file.arrayBuffer();
  const stub = env.SheetsThink.get(env.SheetsThink.idFromName(existingSpreadsheet.agent_name));
  const contentType = file.type || "application/octet-stream";
  let revision: SpreadsheetRevisionRow | null = null;
  let shouldDestroySandbox = false;

  try {
    await env.SPREADSHEETS.put(r2Key, fileBuffer, {
      httpMetadata: { contentType },
      customMetadata: {
        filename: file.name,
        revisionNumber: String(revisionNumber),
        spreadsheetId,
      },
    });

    revision = await recordSpreadsheetRevision(env, {
      action: "revision_upload",
      contentType,
      filename: file.name,
      r2Key,
      revisionNumber,
      sizeBytes: file.size,
      spreadsheetId,
      summary: `Revision ${revisionNumber} uploaded as ${file.name}. Previous latest file was ${existingSpreadsheet.filename}.`,
    });

    await sandbox.mkdir(`/workspace/spreadsheets/${spreadsheetId}`, { recursive: true });
    await sandbox.writeFile(sandboxPath, arrayBufferToBase64(fileBuffer), {
      encoding: "base64",
    });
    shouldDestroySandbox = true;

    const fileResponse = await stub.fetch("https://agent.local/spreadsheet-file", {
      body: JSON.stringify({
        contentType,
        filename: file.name,
        r2Key,
        revisionNumber,
        sandboxPath,
        sizeBytes: file.size,
        spreadsheetId,
        preExtract,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!fileResponse.ok) throw new Error((await fileResponse.text()) || "Failed to persist spreadsheet file.");

    await env.DB.prepare(
      [
        "UPDATE spreadsheets",
        "SET filename = ?, content_type = ?, size_bytes = ?, r2_key = ?, pre_extract = ?, sandbox_path = ?, status = 'processing', error_message = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        "WHERE id = ?",
      ].join(" "),
    )
      .bind(file.name, contentType, file.size, r2Key, preExtract ? 1 : 0, sandboxPath, spreadsheetId)
      .run();

    if (preExtract) {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetId);
      if (!spreadsheet) throw new Error("Failed to load spreadsheet for extraction workflow.");
      await startExtractionWorkflow(env, spreadsheet);
    } else {
      await env.DB.prepare(
        [
          "UPDATE spreadsheets",
          "SET status = 'ready', error_message = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
          "WHERE id = ?",
        ].join(" "),
      )
        .bind(spreadsheetId)
        .run();
    }
  } catch (error) {
    throw error;
  } finally {
    if (shouldDestroySandbox) {
      await destroyUploadSandbox(sandbox, stub);
    }
  }

  const spreadsheet = await getSpreadsheetRow(env, spreadsheetId);
  return json({ revision, spreadsheet }, { status: 201 });
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
    const notReady = extractionNotReadyResponse(spreadsheet);
    if (notReady) return notReady;
    agentName = spreadsheet.agent_name;
  }

  return sendAgentMessage(env, agentName, body.message);
}

async function sendSpreadsheetAgentRequest(request: Request, env: Env, spreadsheetId: string) {
  const spreadsheet = await getSpreadsheetRow(env, spreadsheetId);
  if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
  const notReady = extractionNotReadyResponse(spreadsheet);
  if (notReady) return notReady;

  const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
  if (typeof body.message !== "string" || !body.message.trim()) {
    return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
  }

  return sendAgentMessage(env, spreadsheet.agent_name, body.message);
}

async function sendBenchmarkQuery(request: Request, env: Env) {
  const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
  if (typeof body.message !== "string" || !body.message.trim()) {
    return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
  }

  try {
    const startedAt = Date.now();
    const selection = await selectSpreadsheetForPrompt(env, body.message);
    const notReady = extractionNotReadyResponse(selection.spreadsheet);
    if (notReady) return notReady;

    const answer = await fetchAgentMessageData(env, selection.spreadsheet.agent_name, body.message);
    const answerData = answer.data && typeof answer.data === "object" ? answer.data : { response: answer.data };
    return json(
      {
        ...answerData,
        selectedSpreadsheet: {
          filename: selection.spreadsheet.filename,
          id: selection.spreadsheet.id,
          reason: selection.reason,
          score: selection.score,
        },
        selection: {
          candidates: selection.candidates,
          durationMs: selection.durationMs,
          model: modelConfig(env),
          reason: selection.reason,
          score: selection.score,
          usage: selection.usage,
        },
        totalDurationMs: Date.now() - startedAt,
      },
      { status: answer.status },
    );
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Benchmark query failed." }, { status: 500 });
  }
}

async function selectSpreadsheetForPrompt(env: Env, message: string) {
  const candidates = await spreadsheetSearchCandidates(env);
  if (candidates.length === 0) {
    throw new Error("No ready spreadsheets are available to answer this prompt.");
  }

  if (candidates.length === 1) {
    return {
      candidates,
      durationMs: 0,
      reason: "Only one ready spreadsheet is available.",
      score: 1,
      spreadsheet: (await getSpreadsheetRow(env, candidates[0].id)) as SpreadsheetRow,
      usage: null as unknown,
    };
  }

  const startedAt = Date.now();
  const result = await generateText({
    model: modelForEnv(env),
    prompt: [
      "Choose the single spreadsheet that is most likely to answer the user's question.",
      "Return only JSON with keys: spreadsheet_id, reason, score.",
      "score must be a number from 0 to 1.",
      "Prefer spreadsheets whose description, table names, columns, or sample metadata match the question.",
      "",
      `Question: ${message}`,
      "",
      "Spreadsheets:",
      JSON.stringify(candidates, null, 2),
    ].join("\n"),
    temperature: 0,
  });

  const parsed = parseJsonText(result.text) as {
    reason?: unknown;
    score?: unknown;
    spreadsheet_id?: unknown;
  };
  const selectedId = typeof parsed.spreadsheet_id === "string" ? parsed.spreadsheet_id : candidates[0].id;
  const spreadsheet = await getSpreadsheetRow(env, selectedId);
  if (!spreadsheet) {
    throw new Error(`Spreadsheet selector returned unknown id: ${selectedId}`);
  }

  return {
    candidates,
    durationMs: Date.now() - startedAt,
    reason: typeof parsed.reason === "string" ? parsed.reason : "Selected by spreadsheet metadata.",
    score: typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : null,
    spreadsheet,
    usage: result.usage,
  };
}

async function spreadsheetSearchCandidates(env: Env): Promise<SpreadsheetSearchCandidate[]> {
  const { results } = await env.DB.prepare(
    [
      "SELECT id, filename, content_type, size_bytes, agent_name, category, r2_key, pre_extract, sandbox_path, status, error_message, uploaded_at, updated_at",
      "FROM spreadsheets",
      "WHERE status = 'ready'",
      "ORDER BY updated_at DESC",
      "LIMIT 40",
    ].join(" "),
  ).all<SpreadsheetRow>();

  return Promise.all(
    (results ?? []).map(async (spreadsheet) => {
      const candidate: SpreadsheetSearchCandidate = {
        columns: [],
        description: null,
        filename: spreadsheet.filename,
        id: spreadsheet.id,
        rowCount: 0,
        status: spreadsheet.status,
        tables: [],
        updatedAt: spreadsheet.updated_at,
      };

      if (spreadsheet.pre_extract !== 1) {
        candidate.description = `${spreadsheet.filename} was uploaded without pre-extracted SQL tables.`;
        return candidate;
      }

      try {
        const stub = env.SheetsThink.get(env.SheetsThink.idFromName(spreadsheet.agent_name));
        const response = await stub.fetch("https://agent.local/analysis-tables");
        if (!response.ok) return candidate;
        const analysis = (await response.json()) as {
          analysis?: { description?: string | null } | null;
          tables?: Array<{
            columns?: string[];
            row_count?: number;
            source_name?: string;
            table_name?: string;
          }>;
        };

        candidate.description = analysis.analysis?.description ?? null;
        candidate.tables = (analysis.tables ?? []).map((table) => ({
          columns: table.columns ?? [],
          name: table.table_name ?? "table",
          rowCount: table.row_count ?? 0,
          sourceName: table.source_name ?? "sheet",
        }));
        candidate.columns = [...new Set(candidate.tables.flatMap((table) => table.columns))].slice(0, 80);
        candidate.rowCount = candidate.tables.reduce((sum, table) => sum + table.rowCount, 0);
      } catch {
        return candidate;
      }

      return candidate;
    }),
  );
}

async function fetchAgentMessageData(env: Env, agentName: string, message: string) {
  let stub: DurableObjectStub;
  if (agentName.startsWith("agent-")) {
    stub = env.AgentThink.get(env.AgentThink.idFromName(agentName));
  } else {
    stub = env.SheetsThink.get(env.SheetsThink.idFromName(agentName));
  }
  const response = await stub.fetch("https://agent.local/api-request", {
    body: JSON.stringify({ message }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const data = await response
    .clone()
    .json()
    .catch(async () => ({ error: await response.text() }));
  return { data, status: response.status };
}

async function sendAgentMessage(env: Env, agentName: string, message: string) {
  const { data, status } = await fetchAgentMessageData(env, agentName, message);
  return json(data, { status });
}

async function listLibraryAgents(env: Env) {
  const { results } = await env.DB.prepare(
    [
      "SELECT agents.id, agents.name, agents.description, agents.agent_name, agents.status, agents.error_message, agents.created_at, agents.updated_at,",
      "COUNT(agent_sheets.spreadsheet_id) AS sheet_count",
      "FROM agents",
      "LEFT JOIN agent_sheets ON agent_sheets.agent_id = agents.id",
      "GROUP BY agents.id",
      "ORDER BY agents.updated_at DESC",
    ].join(" "),
  ).all<LibraryAgentRow>();

  return json({ agents: results ?? [] });
}

async function getLibraryAgentRow(env: Env, agentId: string) {
  return env.DB.prepare(
    [
      "SELECT agents.id, agents.name, agents.description, agents.agent_name, agents.status, agents.error_message, agents.created_at, agents.updated_at,",
      "COUNT(agent_sheets.spreadsheet_id) AS sheet_count",
      "FROM agents",
      "LEFT JOIN agent_sheets ON agent_sheets.agent_id = agents.id",
      "WHERE agents.id = ?",
      "GROUP BY agents.id",
    ].join(" "),
  )
    .bind(agentId)
    .first<LibraryAgentRow>();
}

async function listLibraryAgentSheets(env: Env, agentId: string) {
  const { results } = await env.DB.prepare(
    [
      "SELECT spreadsheets.id, spreadsheets.filename, spreadsheets.content_type, spreadsheets.size_bytes, spreadsheets.agent_name, spreadsheets.category,",
      "spreadsheets.r2_key, spreadsheets.pre_extract, spreadsheets.sandbox_path, spreadsheets.status, spreadsheets.error_message,",
      "spreadsheets.uploaded_at, spreadsheets.updated_at, agent_sheets.created_at AS attached_at",
      "FROM agent_sheets",
      "JOIN spreadsheets ON spreadsheets.id = agent_sheets.spreadsheet_id",
      "WHERE agent_sheets.agent_id = ?",
      "ORDER BY spreadsheets.category ASC, spreadsheets.filename ASC",
    ].join(" "),
  )
    .bind(agentId)
    .all<LibraryAgentSheetRow>();

  return results ?? [];
}

async function getLibraryAgent(env: Env, agentId: string) {
  const agent = await getLibraryAgentRow(env, agentId);
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  const sheets = await listLibraryAgentSheets(env, agentId);
  return json({ agent, sheets });
}

async function exportSpreadsheetAnalysis(env: Env, spreadsheet: SpreadsheetRow) {
  const stub = env.SheetsThink.get(env.SheetsThink.idFromName(spreadsheet.agent_name));
  const response = await stub.fetch("https://agent.local/analysis-export");
  if (!response.ok) {
    throw new Error((await response.text()) || `Failed to export ${spreadsheet.filename}.`);
  }
  return response.json() as Promise<{
    analysis: AgentInitializationPayload["sheets"][number]["analysis"];
    metadata?: AgentInitializationPayload["sheets"][number]["metadata"];
    tables: Array<{
      columns: string[];
      rows: Record<string, unknown>[];
      sourceName: string;
      tableName: string;
    }>;
  }>;
}

async function sendLibraryAgentRequest(request: Request, env: Env, agentId: string) {
  const agent = await getLibraryAgentRow(env, agentId);
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });
  if (agent.status !== "ready") return json({ error: `Agent is ${agent.status}. ${agent.error_message ?? ""}`.trim() }, { status: 409 });

  const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
  if (typeof body.message !== "string" || !body.message.trim()) {
    return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
  }

  return sendAgentMessage(env, agent.agent_name, body.message);
}

async function createLibraryAgent(request: Request, env: Env) {
  const body = (await request.json().catch(() => ({}))) as CreateLibraryAgentPayload;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const spreadsheetIds = Array.isArray(body.spreadsheetIds)
    ? [...new Set(body.spreadsheetIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))]
    : [];

  if (!name) return json({ error: "Agent name is required." }, { status: 400 });
  if (spreadsheetIds.length === 0) return json({ error: "Choose at least one Data Library sheet." }, { status: 400 });

  const spreadsheets: SpreadsheetRow[] = [];
  for (const spreadsheetId of spreadsheetIds) {
    const spreadsheet = await getSpreadsheetRow(env, spreadsheetId);
    if (!spreadsheet) return json({ error: `Spreadsheet ${spreadsheetId} was not found.` }, { status: 404 });
    if (spreadsheet.pre_extract !== 1 || spreadsheet.status !== "ready") {
      return json({ error: `${spreadsheet.filename} must be ready and pre-extracted before it can be attached to an Agent.` }, { status: 409 });
    }
    spreadsheets.push(spreadsheet);
  }

  const agentId = crypto.randomUUID();
  const agentName = agentNameForLibraryAgent(agentId);

  await env.DB.prepare(
    [
      "INSERT INTO agents (id, name, description, agent_name, status, error_message, updated_at)",
      "VALUES (?, ?, ?, ?, 'processing', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    ].join(" "),
  )
    .bind(agentId, name, description, agentName)
    .run();

  for (const spreadsheet of spreadsheets) {
    await env.DB.prepare("INSERT INTO agent_sheets (agent_id, spreadsheet_id) VALUES (?, ?)").bind(agentId, spreadsheet.id).run();
  }

  try {
    const sheets: AgentInitializationPayload["sheets"] = [];
    for (const spreadsheet of spreadsheets) {
      const exported = await exportSpreadsheetAnalysis(env, spreadsheet);
      sheets.push({
        analysis: exported.analysis,
        category: spreadsheet.category || "Uncategorised",
        filename: spreadsheet.filename,
        metadata: exported.metadata ?? null,
        spreadsheetId: spreadsheet.id,
        tables: exported.tables,
      });
    }

    const stub = env.AgentThink.get(env.AgentThink.idFromName(agentName));
    const response = await stub.fetch("https://agent.local/initialize-library-agent", {
      body: JSON.stringify({ agentId, description, name, sheets } satisfies AgentInitializationPayload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) throw new Error((await response.text()) || "Failed to initialize Agent database.");

    await env.DB.prepare(
      "UPDATE agents SET status = 'ready', error_message = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
      .bind(agentId)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent creation failed";
    await env.DB.prepare(
      "UPDATE agents SET status = 'failed', error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
      .bind(message, agentId)
      .run();
    throw error;
  }

  const agent = await getLibraryAgentRow(env, agentId);
  const sheets = await listLibraryAgentSheets(env, agentId);
  return json({ agent, sheets }, { status: 201 });
}

async function deleteLibraryAgent(env: Env, agentId: string) {
  const agent = await getLibraryAgentRow(env, agentId);
  if (!agent) return json({ error: "Agent not found" }, { status: 404 });

  const stub = env.AgentThink.get(env.AgentThink.idFromName(agent.agent_name));
  await stub.fetch("https://agent.local/delete-library-agent", { method: "POST" }).catch(() => undefined);
  await env.DB.prepare("DELETE FROM agent_sheets WHERE agent_id = ?").bind(agentId).run();
  await env.DB.prepare("DELETE FROM agents WHERE id = ?").bind(agentId).run();
  return json({ ok: true });
}

async function startExtractionWorkflow(env: Env, spreadsheet: SpreadsheetRow) {
  if (!spreadsheet.r2_key) throw new Error("Spreadsheet file is not available in R2.");

  const instance = await env.EXTRACTION_WORKFLOW.create({
    params: {
      agentName: spreadsheet.agent_name,
      contentType: spreadsheet.content_type || "application/octet-stream",
      filename: spreadsheet.filename,
      r2Key: spreadsheet.r2_key,
      sandboxPath: spreadsheet.sandbox_path ?? `/workspace/spreadsheets/${spreadsheet.id}/${safeFilename(spreadsheet.filename)}`,
      sizeBytes: spreadsheet.size_bytes,
      spreadsheetId: spreadsheet.id,
    } satisfies ExtractionWorkflowParams,
  });

  return instance.id;
}

async function retrySpreadsheetExtraction(env: Env, spreadsheetId: string) {
  const spreadsheet = await getSpreadsheetRow(env, spreadsheetId);
  if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
  if (!spreadsheet.r2_key) return json({ error: "Spreadsheet file is not available in R2." }, { status: 409 });

  await env.DB.prepare(
    [
      "UPDATE spreadsheets",
      "SET status = 'processing', pre_extract = 1, error_message = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      "WHERE id = ?",
    ].join(" "),
  )
    .bind(spreadsheet.id)
    .run();

  try {
    await startExtractionWorkflow(env, spreadsheet);
    const updated = await getSpreadsheetRow(env, spreadsheet.id);
    return json({ spreadsheet: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extraction retry failed";
    await env.DB.prepare(
      [
        "UPDATE spreadsheets",
        "SET status = 'failed', error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        "WHERE id = ?",
      ].join(" "),
    )
      .bind(message, spreadsheet.id)
      .run();
    throw error;
  }
}

async function deleteSpreadsheet(env: Env, spreadsheetId: string) {
  const spreadsheet = await getSpreadsheetRow(env, spreadsheetId);
  if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });

  const stub = env.SheetsThink.get(env.SheetsThink.idFromName(spreadsheet.agent_name));
  const cleanupResponse = await stub.fetch("https://agent.local/delete-spreadsheet", {
    body: JSON.stringify({ spreadsheetId: spreadsheet.id }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!cleanupResponse.ok) {
    throw new Error((await cleanupResponse.text()) || "Failed to clean up spreadsheet agent data.");
  }

  const revisionRows = await listSpreadsheetRevisionRows(env, spreadsheet.id);
  const revisionKeys = new Set(revisionRows.map((revision) => revision.r2_key));
  if (spreadsheet.r2_key) revisionKeys.add(spreadsheet.r2_key);
  await Promise.all(Array.from(revisionKeys).map((r2Key) => env.SPREADSHEETS.delete(r2Key)));

  await env.DB.prepare("DELETE FROM agent_sheets WHERE spreadsheet_id = ?").bind(spreadsheet.id).run();
  await env.DB.prepare("DELETE FROM spreadsheets WHERE id = ?").bind(spreadsheet.id).run();

  if (spreadsheet.sandbox_path) {
    await getSandbox(env.Sandbox, `sandbox-${spreadsheet.id}`).destroy().catch(() => undefined);
    await getSandbox(env.Sandbox, `preview-${spreadsheet.id}`).destroy().catch(() => undefined);
  }

  return json({ ok: true });
}

export class ExtractionWorkflow extends WorkflowEntrypoint<Env, ExtractionWorkflowParams> {
  async run(event: WorkflowEvent<ExtractionWorkflowParams>, step: WorkflowStep) {
    const payload = event.payload;
    const stub = this.env.SheetsThink.get(this.env.SheetsThink.idFromName(payload.agentName));

    await step.do("mark spreadsheet processing", async () => {
      await this.env.DB.prepare(
        [
          "UPDATE spreadsheets",
          "SET status = 'processing', pre_extract = 1, error_message = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
          "WHERE id = ?",
        ].join(" "),
      )
        .bind(payload.spreadsheetId)
        .run();
    });

    try {
      await step.do("store agent file reference", async () => {
        const response = await stub.fetch("https://agent.local/spreadsheet-file", {
          body: JSON.stringify({
            contentType: payload.contentType,
            filename: payload.filename,
            preExtract: true,
            r2Key: payload.r2Key,
            sandboxPath: payload.sandboxPath,
            sizeBytes: payload.sizeBytes,
            spreadsheetId: payload.spreadsheetId,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!response.ok) throw new Error((await response.text()) || "Failed to persist spreadsheet file metadata.");
      });

      const analysis = await step.do(
        "run codemode extraction",
        { retries: { backoff: "exponential", delay: "10 seconds", limit: 2 } },
        async () => {
          const response = await stub.fetch("https://agent.local/retry-extraction", {
            body: JSON.stringify({
              filename: payload.filename,
              sandboxPath: payload.sandboxPath,
              spreadsheetId: payload.spreadsheetId,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          });
          if (!response.ok) throw new Error((await response.text()) || "Failed to analyze spreadsheet file.");
          return response.json() as Promise<Record<string, string | number>>;
        },
      );

      await step.do("mark spreadsheet ready", async () => {
        await this.env.DB.prepare(
          [
            "UPDATE spreadsheets",
            "SET status = 'ready', pre_extract = 1, error_message = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            "WHERE id = ?",
          ].join(" "),
        )
          .bind(payload.spreadsheetId)
          .run();
      });

      return analysis;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extraction workflow failed";
      await step.do("mark spreadsheet failed", async () => {
        await this.env.DB.prepare(
          [
            "UPDATE spreadsheets",
            "SET status = 'failed', error_message = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            "WHERE id = ?",
          ].join(" "),
        )
          .bind(message, payload.spreadsheetId)
          .run();
      });
      throw error;
    }
  }
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

export class SheetsThink extends Think<Env> {
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
      "For questions about upload history, edits, versions, or revisions, call list_spreadsheet_revisions.",
      "Use robust CSV/TSV parsing: sniff delimiters, prefer pandas.read_csv(..., engine='python', on_bad_lines='skip', encoding='utf-8-sig') when using pandas, and fall back to csv.reader for ragged files. Use pandas.read_excel for XLSX/XLS, pandas.read_excel(..., engine='odf') for ODS, and pandas.read_xml or lxml/ElementTree for XML.",
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
      list_spreadsheet_revisions: tool({
        description: "List upload and revision history for this spreadsheet, newest revision first.",
        inputSchema: z.object({}),
        execute: async () => {
          const spreadsheetId = spreadsheetIdFromAgentName(this.name);
          if (!spreadsheetId) throw new Error("This agent is not attached to a spreadsheet.");
          return listSpreadsheetRevisionRows(this.env, spreadsheetId);
        },
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

    if (url.pathname.endsWith("/extraction-trace")) {
      return json({ traces: this.listExtractionTraces() });
    }

    if (url.pathname.endsWith("/analysis-tables") && request.method === "GET") {
      return json(this.listAnalysisTables());
    }

    if (url.pathname.endsWith("/analysis-export") && request.method === "GET") {
      return json(this.exportAnalysisDatabase());
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

    if (url.pathname.endsWith("/retry-extraction") && request.method === "POST") {
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
        return new Response("Invalid extraction retry payload.", { status: 400 });
      }

      const startedAt = Date.now();
      this.recordTrace({
        detail: { filename: body.filename },
        spanType: "ingestion",
        status: "running",
        title: "Extraction retry started",
      });

      try {
        const analysis = await this.analyzeSpreadsheetFile(body.spreadsheetId, body.filename, body.sandboxPath);
        this.recordTrace({
          detail: { score: analysis.score, tables: analysis.tables },
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "done",
          title: "Extraction retry complete",
        });
        return json(analysis);
      } catch (error) {
        this.recordTrace({
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "error",
          title: "Extraction retry failed",
        });
        throw error;
      } finally {
        await getSandbox(this.env.Sandbox, `sandbox-${body.spreadsheetId}`).destroy().catch(() => undefined);
      }
    }

    if (url.pathname.endsWith("/delete-spreadsheet") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        spreadsheetId?: unknown;
      };

      if (typeof body.spreadsheetId !== "string") {
        return new Response("Invalid spreadsheet delete payload.", { status: 400 });
      }

      this.deleteSpreadsheetData(body.spreadsheetId);
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
      CREATE TABLE IF NOT EXISTS document_metadata (
        spreadsheet_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        domain TEXT NOT NULL,
        geography TEXT,
        time_period TEXT,
        units TEXT,
        measures_json TEXT NOT NULL,
        dimensions_json TEXT NOT NULL,
        caveats TEXT,
        source_summary TEXT,
        extraction_notes TEXT,
        confidence_score INTEGER NOT NULL,
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
    const restoreStartedAt = Date.now();
    this.recordTrace({
      detail: traceDetail("Restoring the uploaded file from R2 into the sandbox workspace.", sandboxPath),
      spanType: "ingestion",
      status: "running",
      title: "Preparing sandbox file",
    });
    await this.restoreSpreadsheetFile(spreadsheetId, filename, sandboxPath);
    this.recordTrace({
      detail: traceDetail("The spreadsheet is available on disk for Python code to inspect.", sandboxPath),
      durationMs: Date.now() - restoreStartedAt,
      spanType: "ingestion",
      status: "done",
      title: "Sandbox file ready",
    });

    const sandbox = getSandbox(this.env.Sandbox, `sandbox-${spreadsheetId}`);
    const inspectionStartedAt = Date.now();
    this.recordTrace({
      detail: traceDetail("Running a small Python profiler to identify format, sheets, dimensions, delimiter, and sample rows."),
      spanType: "ingestion",
      status: "running",
      title: "Inspecting document shape",
    });
    const profileResult = await sandbox.exec(
      `python3 - <<'PY'\nSPREADSHEET_PATH = ${JSON.stringify(sandboxPath)}\n${CODEMODE_INSPECTION_SCRIPT}\nPY`,
      { timeout: 60_000 },
    );

    if (!profileResult.success) {
      this.recordTrace({
        detail: traceDetail("The document shape inspection failed before extraction code could be generated.", profileResult.stderr),
        durationMs: Date.now() - inspectionStartedAt,
        spanType: "ingestion",
        status: "error",
        title: "Document inspection failed",
      });
      throw new Error(profileResult.stderr || "Codemode spreadsheet inspection failed.");
    }

    const profile = parseJsonText(profileResult.stdout);
    this.recordTrace({
      detail: traceDetail(
        "The document shape was profiled and will guide the generated extraction code.",
        profileSummary(profile),
      ),
      durationMs: Date.now() - inspectionStartedAt,
      spanType: "ingestion",
      status: "done",
      title: "Document shape inspected",
    });
    const design = await this.designCodemodeExtraction(filename, profile);
    const code = await this.generateCodemodeExtractionCode(filename, profile, design);
    const extractionStartedAt = Date.now();
    this.recordTrace({
      detail: traceDetail("Running the generated Python extraction script in the sandbox.", code),
      spanType: "ingestion",
      status: "running",
      title: "Running extraction code",
    });
    const extractionResult = await sandbox.exec(
      `python3 - <<'PY'\nSPREADSHEET_PATH = ${JSON.stringify(sandboxPath)}\n${code}\nPY`,
      { timeout: 120_000 },
    );

    if (!extractionResult.success) {
      this.recordTrace({
        detail: traceDetail("The generated extraction code failed while reading the spreadsheet.", extractionResult.stderr),
        durationMs: Date.now() - extractionStartedAt,
        spanType: "ingestion",
        status: "error",
        title: "Extraction code failed",
      });
      throw new Error(extractionResult.stderr || "Codemode spreadsheet extraction failed.");
    }

    this.recordTrace({
      detail: traceDetail("The generated extraction code produced JSON for the document database.", extractionResult.stdout),
      durationMs: Date.now() - extractionStartedAt,
      spanType: "ingestion",
      status: "done",
      title: "Extraction code complete",
    });
    const parseStartedAt = Date.now();
    this.recordTrace({
      detail: traceDetail("Validating and normalizing the generated JSON before writing SQLite tables."),
      spanType: "ingestion",
      status: "running",
      title: "Normalizing extraction output",
    });
    const extraction = normalizeCodemodeExtraction(parseJsonText(extractionResult.stdout), filename);
    const review = await this.reviewCodemodeExtraction(filename, profile, design, extraction);
    extraction.metadata.confidence_score = review.score;
    extraction.metadata.extraction_notes = [extraction.metadata.extraction_notes, review.notes].filter(Boolean).join("\n\n");
    this.recordTrace({
      detail: traceDetail("The extraction JSON is valid and has been normalized into table definitions.", {
        description: extraction.description,
        metadata: extraction.metadata,
        tables: extractionTableSummary(extraction),
      }),
      durationMs: Date.now() - parseStartedAt,
      spanType: "ingestion",
      status: "done",
      title: "Extraction output normalized",
    });
    const storeStartedAt = Date.now();
    this.recordTrace({
      detail: traceDetail("Creating dynamic SQLite tables inside this agent durable object.", extractionTableSummary(extraction)),
      spanType: "ingestion",
      status: "running",
      title: "Writing SQLite tables",
    });
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
        ${JSON.stringify({ metadata: extraction.metadata, mode: "codemode", profile })},
        ${extraction.metadata.confidence_score},
        ${new Date().toISOString()}
      )
      ON CONFLICT(spreadsheet_id) DO UPDATE SET
        description = excluded.description,
        deterministic_summary_json = excluded.deterministic_summary_json,
        agent_review_json = excluded.agent_review_json,
        extraction_score = excluded.extraction_score,
        updated_at = excluded.updated_at
    `;
    this.recordTrace({
      detail: traceDetail("The agent SQLite database now contains the extracted document data.", {
        description: extraction.description,
        metadata: extraction.metadata,
        tables: extractionTableSummary(extraction),
      }),
      durationMs: Date.now() - storeStartedAt,
      spanType: "ingestion",
      status: "done",
      title: "SQLite tables ready",
    });

    return { description: extraction.description, mode: "codemode", score: extraction.metadata.confidence_score, tables: extraction.tables.length };
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
    this.sql`DELETE FROM document_metadata WHERE spreadsheet_id = ${spreadsheetId}`;

    this.sql`
      INSERT INTO document_metadata (
        spreadsheet_id,
        title,
        description,
        category,
        domain,
        geography,
        time_period,
        units,
        measures_json,
        dimensions_json,
        caveats,
        source_summary,
        extraction_notes,
        confidence_score,
        updated_at
      )
      VALUES (
        ${spreadsheetId},
        ${extraction.metadata.title},
        ${extraction.metadata.description},
        ${extraction.metadata.category},
        ${extraction.metadata.domain},
        ${extraction.metadata.geography},
        ${extraction.metadata.time_period},
        ${extraction.metadata.units},
        ${JSON.stringify(extraction.metadata.measures)},
        ${JSON.stringify(extraction.metadata.dimensions)},
        ${extraction.metadata.caveats},
        ${extraction.metadata.source_summary},
        ${extraction.metadata.extraction_notes},
        ${extraction.metadata.confidence_score},
        ${new Date().toISOString()}
      )
    `;

    extraction.tables.forEach((table, tableIndex) => {
      const tableName = this.safeSqlIdentifier(`doc_${tableIndex + 1}_${table.name}`);
      const uniqueColumns = this.uniqueSqlColumns(table.columns.filter((column) => !["source_row", "source_ref"].includes(column.toLowerCase())));
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

  private async designCodemodeExtraction(filename: string, profile: unknown) {
    const prompt = [
      "You are codemode's data modeling planner.",
      "Design a semantic SQLite extraction model for this uploaded document.",
      "Return only JSON, no markdown.",
      "Do not mirror the spreadsheet mechanically unless the document is already a clean domain table.",
      "Prefer proper domain tables with clear grain, useful names, typed columns, and provenance columns.",
      "Every fact/observation table must include source_row and source_ref.",
      "Always include a metadata object with title, description, category, domain, geography, time_period, units, measures, dimensions, caveats, source_summary, extraction_notes, confidence_score.",
      "The JSON shape must be:",
      '{"metadata": {"title": string, "description": string, "category": string, "domain": string, "geography": string, "time_period": string, "units": string, "measures": object, "dimensions": object, "caveats": string, "source_summary": string, "extraction_notes": string, "confidence_score": number}, "tables": [{"name": string, "purpose": string, "grain": string, "columns": [{"name": string, "meaning": string}], "source_strategy": string}]}',
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
          detail: traceDetail("Asking the model to design semantic tables and document metadata before code is written.", {
            model: label,
            profile: profileSummary(profile),
          }),
          spanType: "ingestion",
          status: "running",
          title: "Designing semantic schema",
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
        const design = parseJsonText(result.text);
        this.recordTrace({
          detail: traceDetail("The model proposed domain-specific tables and metadata for the extraction.", design),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "done",
          title: "Semantic schema designed",
        });
        return design;
      } catch (error) {
        lastError = error;
        this.recordTrace({
          detail: traceDetail(
            "This model failed to design a semantic schema. The fallback chain will continue if another model is configured.",
            error instanceof Error ? { message: error.message, model: label } : { error, model: label },
          ),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "error",
          title: "Semantic schema design failed",
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to design codemode extraction.");
  }

  private async generateCodemodeExtractionCode(filename: string, profile: unknown, design: unknown) {
    const prompt = [
      "You are in codemode. Generate a complete Python script that reads the uploaded spreadsheet at SPREADSHEET_PATH and prints one JSON object to stdout.",
      "Do not explain the code. Return only Python code, with no markdown fences.",
      "The variable SPREADSHEET_PATH is already defined as the absolute sandbox path. You must read from SPREADSHEET_PATH, not from the filename and not from the current working directory.",
      "Start by assigning path = pathlib.Path(SPREADSHEET_PATH) or Path(SPREADSHEET_PATH), and use that path variable for every file read.",
      "The script must implement the semantic extraction design below, not simply mirror spreadsheet columns unless the design explicitly says to.",
      "The script must print this exact JSON shape:",
      '{"description": string, "filename": string, "format": string, "metadata": {"title": string, "description": string, "category": string, "domain": string, "geography": string, "time_period": string, "units": string, "measures": object, "dimensions": object, "caveats": string, "source_summary": string, "extraction_notes": string, "confidence_score": number}, "tables": [{"name": string, "columns": string[], "rows": [{"source_row": number, "source_ref": string, "cells": object}]}]}',
      "Rules:",
      "- Create domain-specific tables with proper names, grain, and columns based on the semantic design.",
      "- Preserve all meaningful spreadsheet/XML/CSV data, either in semantic tables or an audit/source table if needed.",
      "- Include source_row and source_ref for every extracted row so answers can point back to the original document.",
      "- Include a metadata table worth of content in the metadata object: category, domain, measures, dimensions, units, geography, time period, caveats, source summary, and extraction notes.",
      "- Use pandas for xlsx/xls/ods when useful. Use ElementTree or lxml for XML.",
      "- For CSV/TSV, expect messy real-world files: metadata rows, inconsistent column counts, BOMs, quoted delimiters, blank lines, and semicolon/pipe/tab/comma delimiters.",
      "- For CSV/TSV, sniff the delimiter with csv.Sniffer over a large sample when possible. If using pandas.read_csv, prefer engine='python', dtype=object, keep_default_na=False, encoding='utf-8-sig', and on_bad_lines='skip'.",
      "- If pandas.read_csv raises ParserError or UnicodeDecodeError, fall back to Python csv.reader with encoding='utf-8-sig', errors='replace', preserving row numbers and padding ragged rows instead of failing.",
      "- Normalize NaN, Infinity, pandas.NA, timestamps, decimals, and numpy values into valid JSON values.",
      "- Print with json.dumps(..., ensure_ascii=False, allow_nan=False).",
      "- Never print Python dict reprs, comments, logs, warnings, or NaN tokens.",
      `Filename: ${filename}`,
      "Inspection profile:",
      JSON.stringify(profile, null, 2),
      "Semantic extraction design:",
      JSON.stringify(design, null, 2),
    ].join("\n\n");

    const entries = configuredModelEntries(this.env);
    let lastError: unknown;

    for (const entry of entries) {
      const label = `${entry.provider}:${entry.model}`;
      const startedAt = Date.now();
      try {
        this.recordTrace({
          detail: traceDetail("Asking the configured model to write a robust Python extractor for this document shape.", {
            model: label,
            profile: profileSummary(profile),
          }),
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
        const code = stripCodeFence(result.text);
        this.recordTrace({
          detail: traceDetail("The model returned executable Python code for the sandbox.", {
            code,
            model: label,
          }),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "done",
          title: "Extraction code generated",
        });
        return code;
      } catch (error) {
        lastError = error;
        this.recordTrace({
          detail: traceDetail(
            "This model failed to generate extraction code. The fallback chain will continue if another model is configured.",
            error instanceof Error ? { message: error.message, model: label } : { error, model: label },
          ),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "error",
          title: "Extraction code generation failed",
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Failed to generate extraction code.");
  }

  private async reviewCodemodeExtraction(filename: string, profile: unknown, design: unknown, extraction: CodemodeExtraction) {
    const prompt = [
      "You are codemode's extraction reviewer.",
      "Review whether the generated SQLite extraction is domain-specific, complete, well-metadataed, and source-referenceable.",
      "Return only JSON with keys: score, notes, issues.",
      "score must be an integer from 0 to 100.",
      "Reward semantic tables with clear grain and provenance. Penalize spreadsheet mirroring when better domain tables were possible.",
      `Filename: ${filename}`,
      "Inspection profile:",
      JSON.stringify(profileSummary(profile), null, 2),
      "Semantic design:",
      JSON.stringify(design, null, 2),
      "Extraction summary:",
      JSON.stringify(this.extractionSummary(extraction), null, 2),
    ].join("\n\n");

    const entries = configuredModelEntries(this.env);
    let lastError: unknown;

    for (const entry of entries) {
      const label = `${entry.provider}:${entry.model}`;
      const startedAt = Date.now();
      try {
        this.recordTrace({
          detail: traceDetail("Asking the model to score the semantic extraction and metadata quality.", { model: label }),
          spanType: "ingestion",
          status: "running",
          title: "Reviewing extraction quality",
        });
        const model =
          entry.provider.toLowerCase() === "workers-ai"
            ? createWorkersAI({ binding: this.env.AI })(entry.model)
            : this.getGatewayModel([entry]);
        const result = await generateText({ model, prompt, temperature: 0 });
        const parsed = parseJsonText(result.text) as { issues?: unknown; notes?: unknown; score?: unknown };
        const score = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? Math.max(0, Math.min(100, Math.round(parsed.score))) : extraction.metadata.confidence_score;
        const notes = typeof parsed.notes === "string" ? parsed.notes : JSON.stringify(parsed);
        this.recordTrace({
          detail: traceDetail("The model reviewed the generated domain tables and metadata.", { issues: parsed.issues, notes, score }),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "done",
          title: "Extraction quality reviewed",
        });
        return { notes, score };
      } catch (error) {
        lastError = error;
        this.recordTrace({
          detail: traceDetail(
            "This model failed to review the extraction. The fallback chain will continue if another model is configured.",
            error instanceof Error ? { message: error.message, model: label } : { error, model: label },
          ),
          durationMs: Date.now() - startedAt,
          spanType: "ingestion",
          status: "error",
          title: "Extraction quality review failed",
        });
      }
    }

    return {
      notes: lastError instanceof Error ? `Review failed: ${lastError.message}` : "Review failed.",
      score: extraction.metadata.confidence_score,
    };
  }

  private extractionSummary(extraction: CodemodeExtraction) {
    return {
      description: extraction.description,
      filename: extraction.filename,
      format: extraction.format,
      metadata: extraction.metadata,
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
    const metadata = this.sql`
      SELECT *
      FROM document_metadata
      LIMIT 1
    `;
    const tables = this.sql`
      SELECT table_name, source_name, columns_json, row_count
      FROM document_tables
      ORDER BY table_name
    `;
    return { analysis, metadata, tables };
  }

  private listAnalysisTables() {
    this.ensureFileSchema();
    const analysis = this.sql`
      SELECT spreadsheet_id, description, extraction_score, updated_at
      FROM document_analysis
      LIMIT 1
    `;
    const metadata = this.sql`
      SELECT *
      FROM document_metadata
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

    return { analysis: analysis[0] ?? null, metadata: metadata[0] ?? null, tables };
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

  private exportAnalysisDatabase() {
    const listed = this.listAnalysisTables();
    return {
      analysis: listed.analysis,
      metadata: listed.metadata,
      tables: listed.tables.map((table) => ({
        columns: ["source_row", "source_ref", ...table.columns],
        rows: [...this.ctx.storage.sql.exec(`SELECT * FROM ${this.quoteIdentifier(table.table_name)}`)],
        sourceName: table.source_name,
        tableName: table.table_name,
      })),
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

  private deleteSpreadsheetData(spreadsheetId: string) {
    this.ensureFileSchema();
    this.ensureTraceSchema();
    const tables = this.sql<{ table_name: string }>`
      SELECT table_name FROM document_tables WHERE spreadsheet_id = ${spreadsheetId}
    `;

    for (const table of tables) {
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${this.quoteIdentifier(table.table_name)}`);
    }

    this.sql`DELETE FROM document_tables WHERE spreadsheet_id = ${spreadsheetId}`;
    this.sql`DELETE FROM document_analysis WHERE spreadsheet_id = ${spreadsheetId}`;
    this.sql`DELETE FROM agent_spreadsheet_files WHERE spreadsheet_id = ${spreadsheetId}`;
    this.sql`DELETE FROM agent_traces`;
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

  private listExtractionTraces() {
    this.ensureTraceSchema();
    return this.sql`
      SELECT id, request_id, span_type, title, status, detail, step_number, duration_ms, created_at
      FROM agent_traces
      WHERE span_type IN ('upload', 'ingestion')
      ORDER BY created_at ASC
    `;
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

export class AgentThink extends Think<Env> {
  private agentSchemaReady = false;
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
    if (!gatewayEntries.length) throw new Error("No AI Gateway model configured.");
    const gateway = createAiGateway({
      binding: this.env.AI.gateway(this.env.AI_GATEWAY_ID ?? "default"),
      options: {
        collectLog: true,
        requestTimeoutMs: 120_000,
        retries: { backoff: "exponential", maxAttempts: 3, retryDelayMs: 750 },
        skipCache: true,
      },
    });
    return gateway(gatewayEntries.map((entry) => providerModel(entry.provider, entry.model)));
  }

  getSystemPrompt() {
    return [
      "You are a practical multi-spreadsheet data agent.",
      "You are scoped to a private Durable Object SQLite working database copied from selected Data Library sheets.",
      "The original Data Library sheets are source assets and must never be mutated.",
      "Use describe_agent_database first to understand attached sheets, categories, copied tables, and derived tables.",
      "Use query_agent_database for read-only SELECT/WITH analysis.",
      "Use execute_python only for read-only analysis against AGENT_DATABASE_JSON, an exported JSON snapshot of your private database.",
      "You may create or restructure derived tables only with the dedicated edit tools. Do not claim the original library sheets were edited.",
      "When citing values, include source spreadsheet/table/source_ref/source_row where possible.",
      "Keep answers concise, concrete, and useful.",
    ].join("\n");
  }

  getTools() {
    return {
      apply_data_patch: tool({
        description:
          "Apply a small INSERT/UPDATE/DELETE patch to this Agent's private copied or derived SQLite tables. This never mutates Data Library source sheets.",
        inputSchema: z.object({
          sql: z.string().min(1).describe("A single INSERT, UPDATE, or DELETE statement against the Agent private database."),
        }),
        execute: async ({ sql }) => this.applyAgentDataPatch(sql),
      }),
      create_derived_table: tool({
        description: "Create or replace a derived table inside this Agent's private SQLite database from a read-only SELECT/WITH query.",
        inputSchema: z.object({
          name: z.string().min(1).describe("Name for the private derived table."),
          sql: z.string().min(1).describe("Read-only SELECT/WITH query used to populate the derived table."),
        }),
        execute: async ({ name, sql }) => this.createDerivedAgentTable(name, sql),
      }),
      describe_agent_database: tool({
        description: "Describe this multi-sheet Agent's private copied SQLite database, source sheets, and table mappings.",
        inputSchema: z.object({}),
        execute: async () => this.describeAgentDatabase(),
      }),
      execute_python: tool({
        description: "Execute Python for read-only analysis against AGENT_DATABASE_JSON, an exported JSON snapshot of this Agent's private SQLite data.",
        inputSchema: z.object({ code: z.string().min(1).describe("Python source code to run.") }),
        execute: async ({ code }) => this.runAgentPython(code),
      }),
      query_agent_database: tool({
        description: "Run a read-only SQL SELECT/WITH query against this Agent's private copied SQLite database.",
        inputSchema: z.object({ sql: z.string().min(1).describe("Read-only SQLite SELECT or WITH query.") }),
        execute: async ({ sql }) => this.queryAgentDatabase(sql),
      }),
      rename_or_restructure_table: tool({
        description: "Create a renamed/restructured private table from a SELECT/WITH query, then optionally drop the old private derived table.",
        inputSchema: z.object({
          dropOldTable: z.boolean().optional().describe("Whether to drop oldTableName after creating the new table."),
          newTableName: z.string().min(1),
          oldTableName: z.string().optional(),
          sql: z.string().min(1).describe("Read-only SELECT/WITH query used to populate the new table."),
        }),
        execute: async ({ dropOldTable, newTableName, oldTableName, sql }) =>
          this.restructureAgentTable(newTableName, sql, oldTableName, dropOldTable === true),
      }),
    };
  }

  async onRequest(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/traces")) return json({ traces: this.listTraces(url.searchParams.get("since")) });
    if (url.pathname.endsWith("/extraction-trace")) return json({ traces: this.listExtractionTraces() });
    if (url.pathname.endsWith("/agent-database") && request.method === "GET") return json(this.listAgentDatabaseTables());
    if (url.pathname.endsWith("/agent-table") && request.method === "GET") {
      const tableName = url.searchParams.get("table");
      if (!tableName) return json({ error: "Missing table query parameter." }, { status: 400 });
      return json(this.getAgentDatabaseTable(tableName));
    }
    if (url.pathname.endsWith("/initialize-library-agent") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as AgentInitializationPayload;
      this.initializeLibraryAgent(body);
      return json({ ok: true });
    }
    if (url.pathname.endsWith("/delete-library-agent") && request.method === "POST") {
      this.deleteLibraryAgentData();
      return json({ ok: true });
    }
    if (url.pathname.endsWith("/api-request") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
      if (typeof body.message !== "string" || !body.message.trim()) {
        return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
      }
      const requestId = crypto.randomUUID();
      const startedAt = Date.now();
      const model = modelConfig(this.env);
      this.recordTrace({ detail: { message: body.message, model }, requestId, spanType: "api", status: "running", title: "API request received" });
      try {
        const result = await generateText({
          model: this.getModel(),
          prompt: body.message,
          stopWhen: stepCountIs(8),
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
        return json({ agentName: this.name, finishReason: result.finishReason, model, requestId, response: result.text, usage: result.usage });
      } catch (error) {
        this.recordTrace({
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          requestId,
          spanType: "api",
          status: "error",
          title: "API request failed",
        });
        return json({ error: error instanceof Error ? error.message : "Agent request failed.", requestId }, { status: 500 });
      }
    }
    return super.onRequest(request);
  }

  beforeTurn(ctx: { body?: unknown; messages?: unknown[]; requestId?: string }) {
    const turnKey = this.turnKey(ctx.requestId);
    this.turnStartTimes.set(turnKey, Date.now());
    this.recordTrace({ detail: { messageCount: ctx.messages?.length ?? 0 }, requestId: ctx.requestId, spanType: "turn", status: "running", title: "Agent turn started" });
  }

  beforeStep(ctx: { stepNumber?: number }) {
    this.recordTrace({ spanType: "step", status: "running", stepNumber: ctx.stepNumber, title: `Step ${ctx.stepNumber ?? "?"} started` });
  }

  beforeToolCall(ctx: { input?: unknown; requestId?: string; stepNumber?: number; toolName?: string }) {
    this.recordTrace({ detail: ctx.input, requestId: ctx.requestId, spanType: "tool", status: "running", stepNumber: ctx.stepNumber, title: `Tool ${ctx.toolName ?? "call"} started` });
  }

  afterToolCall(ctx: { durationMs?: number; error?: unknown; output?: unknown; requestId?: string; stepNumber?: number; success?: boolean; toolName?: string }) {
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

  onStepFinish(ctx: { finishReason?: string; requestId?: string; stepNumber?: number; toolCalls?: unknown[]; usage?: unknown }) {
    this.recordTrace({
      detail: { finishReason: ctx.finishReason, toolCalls: ctx.toolCalls?.length ?? 0, usage: ctx.usage },
      requestId: ctx.requestId,
      spanType: "step",
      status: "done",
      stepNumber: ctx.stepNumber,
      title: `Step ${ctx.stepNumber ?? "?"} finished`,
    });
  }

  onChatResponse(result: { requestId?: string; status?: string }) {
    this.recordTrace({ detail: result.status, durationMs: this.finishTurn(result.requestId), requestId: result.requestId, spanType: "turn", status: "done", title: "Agent turn complete" });
  }

  onChatError(error: unknown, ctx?: { requestId?: string; stage?: string }) {
    this.recordTrace({
      detail: error instanceof Error ? { message: error.message, stage: ctx?.stage } : { error, stage: ctx?.stage },
      durationMs: this.finishTurn(ctx?.requestId),
      requestId: ctx?.requestId,
      spanType: "turn",
      status: "error",
      title: "Agent turn failed",
    });
    return error;
  }

  private ensureAgentSchema() {
    if (this.agentSchemaReady) return;
    this.ensureTraceSchema();
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_metadata (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_sources (
        spreadsheet_id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT,
        extraction_score INTEGER,
        metadata_json TEXT,
        updated_at TEXT NOT NULL
      )
    `;
    try {
      this.ctx.storage.sql.exec("ALTER TABLE agent_sources ADD COLUMN metadata_json TEXT");
    } catch (error) {
      if (!(error instanceof Error ? error.message : String(error)).toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_table_mappings (
        table_name TEXT PRIMARY KEY,
        spreadsheet_id TEXT,
        source_table_name TEXT,
        source_name TEXT,
        category TEXT,
        columns_json TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        table_kind TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.agentSchemaReady = true;
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
    this.sql`CREATE INDEX IF NOT EXISTS idx_agent_traces_created_at ON agent_traces (created_at DESC)`;
    this.traceSchemaReady = true;
  }

  private initializeLibraryAgent(input: AgentInitializationPayload) {
    this.ensureAgentSchema();
    this.deleteLibraryAgentData(false);
    this.ensureAgentSchema();
    const now = new Date().toISOString();
    this.sql`
      INSERT INTO agent_metadata (id, name, description, updated_at)
      VALUES (${input.agentId}, ${input.name}, ${input.description}, ${now})
    `;
    input.sheets.forEach((sheet, sheetIndex) => {
      this.sql`
        INSERT INTO agent_sources (spreadsheet_id, filename, category, description, extraction_score, metadata_json, updated_at)
        VALUES (
          ${sheet.spreadsheetId},
          ${sheet.filename},
          ${sheet.category},
          ${sheet.analysis?.description ?? null},
          ${sheet.analysis?.extraction_score ?? null},
          ${JSON.stringify(sheet.metadata ?? null)},
          ${now}
        )
      `;
      sheet.tables.forEach((table, tableIndex) => {
        const tableName = this.safeSqlIdentifier(`sheet_${sheetIndex + 1}_${table.tableName || tableIndex + 1}`);
        this.createPrivateTable(tableName, table.columns, table.rows);
        this.sql`
          INSERT INTO agent_table_mappings (
            table_name,
            spreadsheet_id,
            source_table_name,
            source_name,
            category,
            columns_json,
            row_count,
            table_kind,
            updated_at
          )
          VALUES (
            ${tableName},
            ${sheet.spreadsheetId},
            ${table.tableName},
            ${table.sourceName},
            ${sheet.category},
            ${JSON.stringify(table.columns)},
            ${table.rows.length},
            ${"source_copy"},
            ${now}
          )
        `;
      });
    });
    this.recordTrace({ detail: { sheets: input.sheets.length }, spanType: "ingestion", status: "done", title: "Agent database initialized" });
  }

  private createPrivateTable(tableName: string, columns: string[], rows: Record<string, unknown>[]) {
    const uniqueColumns = this.uniqueSqlColumns(columns);
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${this.quoteIdentifier(tableName)}`);
    const defs = uniqueColumns.map((column) => `${this.quoteIdentifier(column)} TEXT`).join(", ");
    this.ctx.storage.sql.exec(`CREATE TABLE ${this.quoteIdentifier(tableName)} (${defs || `${this.quoteIdentifier("value")} TEXT`})`);
    for (const row of rows) {
      const insertSql = [
        `INSERT INTO ${this.quoteIdentifier(tableName)}`,
        `(${uniqueColumns.map((column) => this.quoteIdentifier(column)).join(", ") || this.quoteIdentifier("value")})`,
        `VALUES (${uniqueColumns.map(() => "?").join(", ") || "?"})`,
      ].join(" ");
      const values = uniqueColumns.length ? uniqueColumns.map((column) => String(row[column] ?? "")) : [""];
      this.ctx.storage.sql.exec(insertSql, ...values);
    }
  }

  private describeAgentDatabase() {
    this.ensureAgentSchema();
    return {
      metadata: this.sql`SELECT * FROM agent_metadata LIMIT 1`[0] ?? null,
      sources: this.sql`SELECT * FROM agent_sources ORDER BY category, filename`,
      tables: this.sql`SELECT * FROM agent_table_mappings ORDER BY table_kind, table_name`,
    };
  }

  private listAgentDatabaseTables() {
    this.ensureAgentSchema();
    const analysis = this.sql`SELECT id AS spreadsheet_id, name AS description, 100 AS extraction_score, updated_at FROM agent_metadata LIMIT 1`[0] ?? null;
    const tables = this.sql<{
      columns_json: string;
      row_count: number;
      source_name: string | null;
      table_name: string;
    }>`
      SELECT table_name, COALESCE(source_name, table_kind) AS source_name, columns_json, row_count
      FROM agent_table_mappings
      ORDER BY table_kind, table_name
    `.map((table) => ({ ...table, columns: parseStringArray(table.columns_json) }));
    return { analysis, tables };
  }

  private getAgentDatabaseTable(tableName: string) {
    this.ensureAgentSchema();
    const table = this.sql<{ columns_json: string; row_count: number; source_name: string | null; table_name: string }>`
      SELECT table_name, COALESCE(source_name, table_kind) AS source_name, columns_json, row_count
      FROM agent_table_mappings
      WHERE table_name = ${tableName}
      LIMIT 1
    `[0];
    if (!table) return { columns: [], rows: [], table: null };
    const columns = parseStringArray(table.columns_json);
    const rows = [...this.ctx.storage.sql.exec(`SELECT * FROM ${this.quoteIdentifier(tableName)} LIMIT 200`)];
    return { columns, rows, table: { ...table, columns } };
  }

  private queryAgentDatabase(sql: string) {
    this.ensureAgentSchema();
    const trimmed = sql.trim();
    const normalized = trimmed.toLowerCase();
    if ((!normalized.startsWith("select ") && !normalized.startsWith("with ")) || normalized.includes(";")) {
      throw new Error("Only a single read-only SELECT/WITH query is allowed.");
    }
    return [...this.ctx.storage.sql.exec(trimmed)].slice(0, 200);
  }

  private createDerivedAgentTable(name: string, sql: string) {
    this.ensureAgentSchema();
    const normalized = sql.trim().toLowerCase();
    if ((!normalized.startsWith("select ") && !normalized.startsWith("with ")) || normalized.includes(";")) {
      throw new Error("Derived tables must be created from a single SELECT/WITH query.");
    }
    const tableName = this.safeSqlIdentifier(`derived_${name}`);
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${this.quoteIdentifier(tableName)}`);
    this.ctx.storage.sql.exec(`CREATE TABLE ${this.quoteIdentifier(tableName)} AS ${sql.trim()}`);
    const columns = this.tableColumns(tableName);
    const rowCount = this.tableRowCount(tableName);
    this.sql`
      INSERT INTO agent_table_mappings (table_name, spreadsheet_id, source_table_name, source_name, category, columns_json, row_count, table_kind, updated_at)
      VALUES (${tableName}, NULL, NULL, ${name}, ${"Derived"}, ${JSON.stringify(columns)}, ${rowCount}, ${"derived"}, ${new Date().toISOString()})
      ON CONFLICT(table_name) DO UPDATE SET columns_json = excluded.columns_json, row_count = excluded.row_count, updated_at = excluded.updated_at
    `;
    return { tableName, columns, rowCount };
  }

  private applyAgentDataPatch(sql: string) {
    this.ensureAgentSchema();
    const trimmed = sql.trim();
    const normalized = trimmed.toLowerCase();
    if ((!normalized.startsWith("insert ") && !normalized.startsWith("update ") && !normalized.startsWith("delete ")) || normalized.includes(";")) {
      throw new Error("Only a single INSERT/UPDATE/DELETE patch is allowed.");
    }
    this.ctx.storage.sql.exec(trimmed);
    return { ok: true };
  }

  private restructureAgentTable(newTableName: string, sql: string, oldTableName?: string, dropOldTable = false) {
    const created = this.createDerivedAgentTable(newTableName, sql);
    if (dropOldTable && oldTableName) {
      const safeOld = this.safeSqlIdentifier(oldTableName);
      this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${this.quoteIdentifier(safeOld)}`);
      this.sql`DELETE FROM agent_table_mappings WHERE table_name = ${safeOld}`;
    }
    return created;
  }

  private async runAgentPython(code: string) {
    this.ensureAgentSchema();
    const snapshot = JSON.stringify(this.exportAgentSnapshot());
    const sandbox = getSandbox(this.env.Sandbox, `agent-python-${this.name}`);
    const result = await sandbox.exec(
      `python3 - <<'PY'\nAGENT_DATABASE_JSON = ${JSON.stringify(snapshot)}\n${code}\nPY`,
      { timeout: 30_000 },
    );
    await sandbox.destroy().catch(() => undefined);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, success: result.success };
  }

  private exportAgentSnapshot() {
    const tables = this.sql<{ table_name: string }>`SELECT table_name FROM agent_table_mappings ORDER BY table_name`;
    return {
      database: this.describeAgentDatabase(),
      tables: Object.fromEntries(
        tables.map((table) => [table.table_name, [...this.ctx.storage.sql.exec(`SELECT * FROM ${this.quoteIdentifier(table.table_name)} LIMIT 500`)]]),
      ),
    };
  }

  private deleteLibraryAgentData(dropTraces = true) {
    this.ensureAgentSchema();
    const tables = this.sql<{ table_name: string }>`SELECT table_name FROM agent_table_mappings`;
    for (const table of tables) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${this.quoteIdentifier(table.table_name)}`);
    this.sql`DELETE FROM agent_table_mappings`;
    this.sql`DELETE FROM agent_sources`;
    this.sql`DELETE FROM agent_metadata`;
    if (dropTraces) this.sql`DELETE FROM agent_traces`;
  }

  private tableColumns(tableName: string) {
    return [...this.ctx.storage.sql.exec(`PRAGMA table_info(${this.quoteIdentifier(tableName)})`)].map((row) => String(row.name));
  }

  private tableRowCount(tableName: string) {
    const rows = [...this.ctx.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${this.quoteIdentifier(tableName)}`)];
    return Number(rows[0]?.count ?? 0);
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

  private listExtractionTraces() {
    this.ensureTraceSchema();
    return this.sql`
      SELECT id, request_id, span_type, title, status, detail, step_number, duration_ms, created_at
      FROM agent_traces
      WHERE span_type IN ('upload', 'ingestion')
      ORDER BY created_at ASC
    `;
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
      INSERT INTO agent_traces (id, request_id, span_type, title, status, detail, step_number, duration_ms, created_at)
      VALUES (${trace.id}, ${trace.request_id}, ${trace.span_type}, ${trace.title}, ${trace.status}, ${trace.detail}, ${trace.step_number}, ${trace.duration_ms}, ${trace.created_at})
    `;
    this.broadcast(JSON.stringify({ trace, type: "agent_trace" }));
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

    if (url.pathname === "/api/benchmarks/query" && request.method === "POST") {
      return sendBenchmarkQuery(request, env);
    }

    if (url.pathname === "/api/spreadsheets" && request.method === "GET") {
      return listSpreadsheets(env);
    }

    if (url.pathname === "/api/spreadsheets" && request.method === "POST") {
      return uploadSpreadsheet(request, env);
    }

    if (url.pathname === "/api/agents" && request.method === "GET") {
      return listLibraryAgents(env);
    }

    if (url.pathname === "/api/agents" && request.method === "POST") {
      return createLibraryAgent(request, env);
    }

    const agentRequestMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/agent-request$/);
    if (agentRequestMatch && request.method === "POST") {
      return sendLibraryAgentRequest(request, env, agentRequestMatch[1]);
    }

    const agentTablesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/tables$/);
    if (agentTablesMatch && request.method === "GET") {
      const agent = await getLibraryAgentRow(env, agentTablesMatch[1]);
      if (!agent) return json({ error: "Agent not found" }, { status: 404 });
      const stub = env.AgentThink.get(env.AgentThink.idFromName(agent.agent_name));
      return stub.fetch("https://agent.local/agent-database");
    }

    const agentTableMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/tables\/([^/]+)$/);
    if (agentTableMatch && request.method === "GET") {
      const agent = await getLibraryAgentRow(env, agentTableMatch[1]);
      if (!agent) return json({ error: "Agent not found" }, { status: 404 });
      const tableUrl = new URL("https://agent.local/agent-table");
      tableUrl.searchParams.set("table", decodeURIComponent(agentTableMatch[2]));
      const stub = env.AgentThink.get(env.AgentThink.idFromName(agent.agent_name));
      return stub.fetch(tableUrl);
    }

    const agentTraceMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/traces$/);
    if (agentTraceMatch && request.method === "GET") {
      const agent = await getLibraryAgentRow(env, agentTraceMatch[1]);
      if (!agent) return json({ error: "Agent not found" }, { status: 404 });
      const stub = env.AgentThink.get(env.AgentThink.idFromName(agent.agent_name));
      const traceUrl = new URL(request.url);
      traceUrl.pathname = "/traces";
      return stub.fetch(new Request(traceUrl, request));
    }

    const agentExtractionTraceMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/extraction-trace$/);
    if (agentExtractionTraceMatch && request.method === "GET") {
      const agent = await getLibraryAgentRow(env, agentExtractionTraceMatch[1]);
      if (!agent) return json({ error: "Agent not found" }, { status: 404 });
      const stub = env.AgentThink.get(env.AgentThink.idFromName(agent.agent_name));
      return stub.fetch("https://agent.local/extraction-trace");
    }

    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch && request.method === "GET") {
      return getLibraryAgent(env, agentMatch[1]);
    }

    if (agentMatch && request.method === "DELETE") {
      return deleteLibraryAgent(env, agentMatch[1]);
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

    const spreadsheetRetryExtractionMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/retry-extraction$/);
    if (spreadsheetRetryExtractionMatch && request.method === "POST") {
      return retrySpreadsheetExtraction(env, spreadsheetRetryExtractionMatch[1]);
    }

    const spreadsheetRevisionsMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/revisions$/);
    if (spreadsheetRevisionsMatch && request.method === "GET") {
      return listSpreadsheetRevisions(env, spreadsheetRevisionsMatch[1]);
    }

    if (spreadsheetRevisionsMatch && request.method === "POST") {
      return uploadSpreadsheetRevision(request, env, spreadsheetRevisionsMatch[1]);
    }

    const spreadsheetDeleteMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)$/);
    if (spreadsheetDeleteMatch && request.method === "DELETE") {
      return deleteSpreadsheet(env, spreadsheetDeleteMatch[1]);
    }

    const spreadsheetTablesMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/tables$/);
    if (spreadsheetTablesMatch && request.method === "GET") {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetTablesMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
      const stub = env.SheetsThink.get(env.SheetsThink.idFromName(spreadsheet.agent_name));
      return stub.fetch("https://agent.local/analysis-tables");
    }

    const spreadsheetTableMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/tables\/([^/]+)$/);
    if (spreadsheetTableMatch && request.method === "GET") {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetTableMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
      const tableUrl = new URL("https://agent.local/analysis-table");
      tableUrl.searchParams.set("table", decodeURIComponent(spreadsheetTableMatch[2]));
      const stub = env.SheetsThink.get(env.SheetsThink.idFromName(spreadsheet.agent_name));
      return stub.fetch(tableUrl);
    }

    const spreadsheetRawPreviewMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/raw-preview$/);
    if (spreadsheetRawPreviewMatch && request.method === "GET") {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetRawPreviewMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
      const stub = env.SheetsThink.get(env.SheetsThink.idFromName(spreadsheet.agent_name));
      return stub.fetch("https://agent.local/raw-preview");
    }

    const spreadsheetTraceMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/traces$/);
    if (spreadsheetTraceMatch && request.method === "GET") {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetTraceMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });

      const id = env.SheetsThink.idFromName(spreadsheet.agent_name);
      const stub = env.SheetsThink.get(id);
      const traceUrl = new URL(request.url);
      traceUrl.pathname = "/traces";
      return stub.fetch(new Request(traceUrl, request));
    }

    const spreadsheetExtractionTraceMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/extraction-trace$/);
    if (spreadsheetExtractionTraceMatch && request.method === "GET") {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetExtractionTraceMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
      const stub = env.SheetsThink.get(env.SheetsThink.idFromName(spreadsheet.agent_name));
      return stub.fetch("https://agent.local/extraction-trace");
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
