import { getSandbox, proxyToSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";
import { routeAgentRequest } from "agents";
import { createAiGateway } from "ai-gateway-provider";
import { createAnthropic } from "ai-gateway-provider/providers/anthropic";
import { createOpenAI } from "ai-gateway-provider/providers/openai";
import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export { Sandbox } from "@cloudflare/sandbox";

export type Env = {
  AI: Ai;
  AI_GATEWAY_FALLBACKS?: string;
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_MODEL?: string;
  AI_GATEWAY_PROVIDER?: string;
  ASSETS: Fetcher;
  DB: D1Database;
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_MODEL_ID?: string;
  ELEVENLABS_OUTPUT_FORMAT?: string;
  ELEVENLABS_VOICE_ID?: string;
  EXTRACTION_WORKFLOW: Workflow;
  HackathonAgent: any;
  LOADER: WorkerLoader;
  SheetsThink: any;
  AgentThink: any;
  Sandbox: DurableObjectNamespace<SandboxType>;
  SPREADSHEETS: R2Bucket;
};

const DEFAULT_AI_GATEWAY_PROVIDER = "anthropic";
const DEFAULT_AI_GATEWAY_MODEL = "claude-sonnet-4-6";

export type SpreadsheetRow = {
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

export type TraceInput = {
  detail?: unknown;
  durationMs?: number;
  requestId?: string;
  spanType: string;
  status: "running" | "done" | "error";
  stepNumber?: number;
  title: string;
};

export type AgentTraceEvent = {
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

export type AgentChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  created_at: string;
};

export type AgentRequestPayload = {
  accessMode?: unknown;
  agentName?: unknown;
  message?: unknown;
  model?: unknown;
  spreadsheetId?: unknown;
};

export type ModelEntry = {
  model: string;
  provider: string;
};

export type CodemodeExtraction = {
  description: string;
  filename: string;
  format: string;
  metadata: {
    category: string;
    caveats: string;
    confidence_score: number;
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

type BenchmarkRunPayload = {
  answer?: unknown;
  answerSeconds?: unknown;
  error?: unknown;
  evidence?: unknown;
  finishReason?: unknown;
  inputTokens?: unknown;
  modelName?: unknown;
  modelProvider?: unknown;
  outputTokens?: unknown;
  prompt?: unknown;
  quality?: unknown;
  requestId?: unknown;
  spreadsheetFilename?: unknown;
  spreadsheetId?: unknown;
  totalSeconds?: unknown;
  totalTokens?: unknown;
  uploadSeconds?: unknown;
};

type SpeechPayload = {
  language?: unknown;
  text?: unknown;
};

type DatasetAgentRequestPayload = AgentRequestPayload & {
  category?: unknown;
};

type DatasetAgentPendingPayload = AgentRequestPayload;

type DataGovPackage = {
  id?: string;
  notes?: string;
  organization?: { title?: string };
  resources?: DataGovResource[];
  title?: string;
};

type DataGovResource = {
  description?: string;
  format?: string;
  id?: string;
  last_modified?: string;
  name?: string;
  size?: number;
  url?: string;
};

type BenchmarkRunRow = {
  answer: string;
  answer_seconds: number;
  created_at: string;
  error: string | null;
  evidence_json: string | null;
  finish_reason: string | null;
  id: string;
  input_tokens: number | null;
  model_name: string | null;
  model_provider: string | null;
  output_tokens: number | null;
  prompt: string;
  quality: number | null;
  request_id: string | null;
  spreadsheet_filename: string | null;
  spreadsheet_id: string;
  total_seconds: number;
  total_tokens: number | null;
  upload_seconds: number | null;
};

export type AgentInitializationPayload = {
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

export type ExtractionWorkflowParams = {
  agentName: string;
  contentType: string;
  filename: string;
  r2Key: string;
  sandboxPath: string;
  sizeBytes: number;
  spreadsheetId: string;
};

const DEFAULT_SCRIPT = [
  "from datetime import datetime",
  "numbers = [3, 5, 8, 13]",
  "print('Hello from Cloudflare Sandbox Python!')",
  "print('sum =', sum(numbers))",
  "print('utc =', datetime.utcnow().isoformat(timespec='seconds'))",
].join("\n");

export function arrayBufferToBase64(buffer: ArrayBuffer) {
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

export async function runPython(env: Env, code = DEFAULT_SCRIPT, spreadsheet?: SpreadsheetRow | null) {
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

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    headers: {
      "cache-control": "no-store",
      ...init?.headers,
    },
    status: init?.status,
    statusText: init?.statusText,
  });
}

export function stripCodeFence(text: string) {
  return text
    .trim()
    .replace(/^```(?:python|py)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

export function parseJsonText(text: string) {
  const trimmed = stripCodeFence(text);
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const jsonStart = starts.length ? Math.min(...starts) : -1;
  const jsonText = jsonStart >= 0 ? balancedJsonSlice(trimmed.slice(jsonStart)) : trimmed;
  return JSON.parse(jsonText.replace(/\b(?:NaN|Infinity|-Infinity)\b/g, "null"));
}

function collectGeneratedTextParts(value: unknown, output: string[]) {
  if (value === null || value === undefined || output.length > 40) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) output.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectGeneratedTextParts(item, output);
    return;
  }
  if (typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const partType = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (partType === "text" || partType === "output_text" || partType === "response.output_text") {
    collectGeneratedTextParts(record.text ?? record.content ?? record.value, output);
    return;
  }

  for (const key of ["text", "content", "message", "output", "response", "messages"]) {
    const next = record[key];
    if (next !== value) collectGeneratedTextParts(next, output);
  }
}

export function generatedTextFromResult(result: unknown) {
  if (typeof result === "object" && result !== null) {
    const direct = (result as { text?: unknown }).text;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
  }

  const parts: string[] = [];
  collectGeneratedTextParts(result, parts);
  return Array.from(new Set(parts)).join("\n\n").trim();
}

export function parseStringArray(text: string) {
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

export function normalizeCodemodeExtraction(value: unknown, filename: string): CodemodeExtraction {
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

export function configuredModelEntries(env: Env): ModelEntry[] {
  const fallbackEntries = env.AI_GATEWAY_FALLBACKS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (fallbackEntries?.length) {
    return fallbackEntries.map((entry) => {
      const separator = entry.indexOf(":");
      if (separator < 1) return { model: entry, provider: env.AI_GATEWAY_PROVIDER ?? DEFAULT_AI_GATEWAY_PROVIDER };
      return {
        model: entry.slice(separator + 1).trim(),
        provider: entry.slice(0, separator).trim(),
      };
    });
  }

  return [
    {
      model: env.AI_GATEWAY_MODEL ?? DEFAULT_AI_GATEWAY_MODEL,
      provider: env.AI_GATEWAY_PROVIDER ?? DEFAULT_AI_GATEWAY_PROVIDER,
    },
  ];
}

export function modelKey(entry: ModelEntry) {
  return `${entry.provider}:${entry.model}`;
}

export function requestedModelEntry(env: Env, payload: AgentRequestPayload): ModelEntry | undefined {
  if (payload.model === undefined || payload.model === null || payload.model === "") return undefined;
  if (typeof payload.model !== "object") {
    throw new Error("Model must be an object with provider and model.");
  }

  const requested = payload.model as { model?: unknown; provider?: unknown };
  const requestedProvider = requested.provider;
  const requestedModel = requested.model;
  if (typeof requestedProvider !== "string" || typeof requestedModel !== "string") {
    throw new Error("Model must include string provider and model values.");
  }

  const configured = configuredModelEntries(env);
  const match = configured.find(
    (entry) => entry.provider.toLowerCase() === requestedProvider.toLowerCase() && entry.model === requestedModel,
  );
  if (!match) {
    throw new Error(`Model ${requestedProvider}:${requestedModel} is not configured.`);
  }

  return match;
}

export function modelEntriesForRequest(env: Env, selectedModel?: ModelEntry) {
  return selectedModel ? [selectedModel] : configuredModelEntries(env);
}

export function modelConfig(env: Env, selectedModel?: ModelEntry) {
  const entries = modelEntriesForRequest(env, selectedModel);
  const primary = entries[0] ?? {
    model: DEFAULT_AI_GATEWAY_MODEL,
    provider: DEFAULT_AI_GATEWAY_PROVIDER,
  };

  return {
    fallbackModels: entries.slice(1),
    gatewayId: env.AI_GATEWAY_ID ?? "default",
    model: primary.model,
    provider: primary.provider,
  };
}

function listAvailableModels(env: Env) {
  const models = configuredModelEntries(env);
  return json({
    defaultModel: models[0] ?? null,
    gatewayId: env.AI_GATEWAY_ID ?? "default",
    models,
  });
}

export function providerModel(providerName: string, modelId: string) {
  const provider = providerName.toLowerCase();

  if (provider === "anthropic") return createAnthropic()(modelId);
  if (provider === "openai") return createOpenAI().chat(modelId);

  throw new Error(
    `Unsupported AI_GATEWAY_PROVIDER "${providerName}". Use workers-ai, openai, or anthropic.`,
  );
}

function modelForEnv(env: Env, selectedModel?: ModelEntry) {
  const entries = modelEntriesForRequest(env, selectedModel);
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

export function spreadsheetIdFromAgentName(agentName: string) {
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

type SpeechLanguage = "english" | "welsh" | "gaelic";

const speechLanguageLabels: Record<SpeechLanguage, string> = {
  english: "English",
  gaelic: "Scottish Gaelic",
  welsh: "Welsh",
};

function cleanSpeechLanguage(value: unknown): SpeechLanguage {
  return value === "welsh" || value === "gaelic" ? value : "english";
}

async function translateSpeechText(text: string, language: SpeechLanguage, env: Env) {
  if (language === "english") return text;

  try {
    const result = await generateText({
      model: modelForEnv(env),
      prompt: [
        `Translate the following short spoken summary into ${speechLanguageLabels[language]}.`,
        "Keep names, numbers, percentages, currencies, table names, and source references unchanged.",
        "Return only the translated text. No markdown. No explanation.",
        "",
        text,
      ].join("\n"),
      temperature: 0,
    });
    const translated = result.text.trim();
    return translated || text;
  } catch {
    return text;
  }
}

export function safeTraceDetail(detail: unknown) {
  if (detail === undefined) return null;

  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  return text.length > 80_000 ? `${text.slice(0, 80_000)}...` : text;
}

function traceSnippet(value: unknown, limit = 900) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

export function traceDetail(summary: string, snippet?: unknown, options?: { snippetLimit?: number }) {
  return {
    snippet: snippet === undefined ? undefined : traceSnippet(snippet, options?.snippetLimit),
    summary,
  };
}

export function jsonRenderResponseInstructions() {
  return [
    "For user-facing answers, return ONLY a valid json-render React flat spec JSON object. Do not return markdown, prose outside JSON, or fenced code blocks.",
    "The spec shape must be: {\"root\":\"root\",\"elements\":{\"root\":{\"type\":\"Stack\",\"props\":{\"direction\":\"vertical\",\"gap\":\"lg\"},\"children\":[...]}, ...}}.",
    "Available components: Stack, Grid, Card, Heading, Text, Badge, Alert, Separator, Table, StatGrid, BarChart, LineChart, AreaChart, VerticalBarChart, PieChart, ScatterChart, ComposedChart, KeyValueList, DataTable.",
    "Use Heading and Text for prose sections. Use StatGrid for KPIs, counts, totals, percentages, scores, and deltas. Use DataTable or Table for compact tabular facts. Use BarChart for ranked horizontal comparisons. Use LineChart for trends over time, AreaChart for volumes/cumulative trends, VerticalBarChart for category-by-period or grouped bars, PieChart for small part-to-whole splits, ScatterChart for relationships between two numeric measures, and ComposedChart when bars plus a trend line clarify the story. Use KeyValueList for metadata, assumptions, source notes, and citations. Use Alert for warnings, caveats, or important findings. Use Card/Grid/Stack to compose the answer.",
    "Keep the UI compact because it renders inside a chat message. Do not emit empty Heading or Text elements. Avoid deep nesting and avoid wrapping every section in a Card.",
    "Use at most 3 StatGrid items by default; use 4 only when all labels and values are short. Do not put long filenames, IDs, or prose into StatGrid values. Put those in KeyValueList, DataTable captions, or short Text instead.",
    "Keep tables small and readable. Prefer 3-8 rows unless the user asks for exhaustive output. Include source_ref/source_row/source table notes in KeyValueList or captions when available.",
    "All display text must be in props. Do not put markdown headings, bullets, or tables inside Text. Use multiple json-render elements instead.",
    "Axis chart props shape: {\"title\":\"...\",\"description\":null,\"xKey\":\"period\",\"yLabel\":null,\"height\":280,\"series\":[{\"key\":\"value\",\"label\":\"Value\",\"color\":null}],\"data\":[{\"period\":\"2024\",\"value\":42}]}. PieChart props shape: {\"title\":\"...\",\"description\":null,\"valueLabel\":\"items\",\"donut\":true,\"height\":260,\"data\":[{\"label\":\"A\",\"value\":10,\"color\":null}]}. ScatterChart props shape: {\"title\":\"...\",\"description\":null,\"xKey\":\"x\",\"yKey\":\"y\",\"nameKey\":null,\"color\":null,\"height\":280,\"data\":[{\"x\":1,\"y\":2,\"label\":\"A\"}]}. ComposedChart props shape: {\"title\":\"...\",\"description\":null,\"xKey\":\"period\",\"height\":300,\"bars\":[{\"key\":\"count\",\"label\":\"Count\",\"color\":null}],\"lines\":[{\"key\":\"rate\",\"label\":\"Rate\",\"color\":null}],\"areas\":[],\"data\":[{\"period\":\"Q1\",\"count\":100,\"rate\":4.2}]}.",
    "Example custom components: {\"type\":\"StatGrid\",\"props\":{\"items\":[{\"label\":\"Rows\",\"value\":\"1,019\",\"delta\":null,\"description\":\"Total entities found\"}]},\"children\":[]}; {\"type\":\"LineChart\",\"props\":{\"title\":\"Inflation over time\",\"description\":null,\"xKey\":\"month\",\"yLabel\":\"%\",\"height\":280,\"series\":[{\"key\":\"inflation\",\"label\":\"Inflation\",\"color\":null}],\"data\":[{\"month\":\"Jan\",\"inflation\":4.1}]},\"children\":[]}; {\"type\":\"BarChart\",\"props\":{\"title\":\"Entities by sector\",\"valueLabel\":\"entities\",\"data\":[{\"label\":\"Central Government\",\"value\":657}]},\"children\":[]}; {\"type\":\"DataTable\",\"props\":{\"columns\":[\"Sector\",\"Entity Count\"],\"rows\":[{\"Sector\":\"Central Government\",\"Entity Count\":\"657\"}],\"caption\":\"Derived from extracted table\"},\"children\":[]}.",
  ].join("\n");
}

export function safeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function r2KeyForSpreadsheet(id: string, filename: string) {
  return `spreadsheets/${id}/${safeFilename(filename)}`;
}

function revisionR2KeyForSpreadsheet(id: string, revisionNumber: number, filename: string) {
  return `spreadsheets/${id}/revisions/${revisionNumber}/${safeFilename(filename)}`;
}

function contentDispositionFilename(filename: string) {
  const fallback = safeFilename(filename) || "spreadsheet";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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

export async function getSpreadsheetRow(env: Env, id: string) {
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

export async function listSpreadsheetRevisionRows(env: Env, spreadsheetId: string) {
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
          detail: "File is durable in R2; codemode pre-extraction was skipped.",
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
  const fileBuffer = await file.arrayBuffer();
  const stub = env.SheetsThink.get(env.SheetsThink.idFromName(existingSpreadsheet.agent_name));
  const contentType = file.type || "application/octet-stream";
  let revision: SpreadsheetRevisionRow | null = null;

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
  }

  const spreadsheet = await getSpreadsheetRow(env, spreadsheetId);
  return json({ revision, spreadsheet }, { status: 201 });
}

async function sendAgentRequest(request: Request, env: Env) {
  const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
  if (typeof body.message !== "string" || !body.message.trim()) {
    return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
  }
  let selectedModel: ModelEntry | undefined;
  try {
    selectedModel = requestedModelEntry(env, body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid model." }, { status: 400 });
  }

  let agentName = typeof body.agentName === "string" && body.agentName.trim() ? body.agentName.trim() : "api-agent";

  if (typeof body.spreadsheetId === "string" && body.spreadsheetId.trim()) {
    const spreadsheet = await getSpreadsheetRow(env, body.spreadsheetId.trim());
    if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
    const notReady = extractionNotReadyResponse(spreadsheet);
    if (notReady) return notReady;
    agentName = spreadsheet.agent_name;
  }

  return sendAgentMessage(env, agentName, body.message, selectedModel, body.accessMode);
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
  let selectedModel: ModelEntry | undefined;
  try {
    selectedModel = requestedModelEntry(env, body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid model." }, { status: 400 });
  }

  return sendAgentMessage(env, spreadsheet.agent_name, body.message, selectedModel, body.accessMode);
}

async function sendBenchmarkQuery(request: Request, env: Env) {
  const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
  if (typeof body.message !== "string" || !body.message.trim()) {
    return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
  }
  let selectedModel: ModelEntry | undefined;
  try {
    selectedModel = requestedModelEntry(env, body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid model." }, { status: 400 });
  }

  try {
    const startedAt = Date.now();
    const selection = await selectSpreadsheetForPrompt(env, body.message, selectedModel);
    const notReady = extractionNotReadyResponse(selection.spreadsheet);
    if (notReady) return notReady;

    const answer = await fetchAgentMessageData(env, selection.spreadsheet.agent_name, body.message, selectedModel);
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
          model: modelConfig(env, selectedModel),
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

function keywordSet(value: string) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length > 2),
  );
}

function lexicalScore(query: string, text: string) {
  const terms = keywordSet(query);
  if (terms.size === 0) return 0;
  const haystack = keywordSet(text);
  let matches = 0;
  for (const term of terms) {
    if (haystack.has(term)) matches += 1;
  }
  return matches / terms.size;
}

function candidateSearchText(candidate: SpreadsheetSearchCandidate) {
  return [
    candidate.filename,
    candidate.description,
    candidate.status,
    candidate.columns.join(" "),
    candidate.tables.map((table) => `${table.name} ${table.sourceName} ${table.columns.join(" ")}`).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function supportedResource(resource: DataGovResource) {
  const format = (resource.format ?? "").toLowerCase();
  const url = resource.url ?? "";
  return (
    format.includes("csv") ||
    format.includes("tsv") ||
    format.includes("xls") ||
    format.includes("xlsx") ||
    format.includes("ods") ||
    format.includes("xml") ||
    /\.(csv|tsv|xlsx?|ods|xml)(?:[?#].*)?$/i.test(url)
  );
}

function filenameFromResource(resource: DataGovResource, dataset: DataGovPackage) {
  const urlName = resource.url ? decodeURIComponent(new URL(resource.url).pathname.split("/").filter(Boolean).pop() ?? "") : "";
  const base = resource.name || dataset.title || dataset.id || "data-gov-resource";
  const format = (resource.format || urlName.split(".").pop() || "csv").toLowerCase().replace(/[^a-z0-9]/g, "");
  const filename = urlName && /\.[a-z0-9]+$/i.test(urlName) ? urlName : `${base}.${format || "csv"}`;
  return safeFilename(filename);
}

async function searchLocalDataset(env: Env, message: string) {
  const candidates = await spreadsheetSearchCandidates(env);
  const ranked = candidates
    .map((candidate) => ({ candidate, score: lexicalScore(message, candidateSearchText(candidate)) }))
    .sort((a, b) => b.score - a.score);
  return { candidates, match: ranked[0] ?? null };
}

async function searchDataGov(message: string) {
  const url = new URL("https://data.gov.uk/api/action/package_search");
  url.searchParams.set("q", message);
  url.searchParams.set("rows", "8");

  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "xlsx-song-agent-sandbox/1.0" },
  });
  if (!response.ok) throw new Error(`data.gov.uk search failed with ${response.status}`);

  const data = (await response.json()) as {
    result?: { results?: DataGovPackage[] };
    success?: boolean;
  };
  const packages = data.result?.results ?? [];
  const resources = packages.flatMap((dataset) =>
    (dataset.resources ?? [])
      .filter(supportedResource)
      .map((resource) => ({
        dataset,
        resource,
        score: lexicalScore(message, `${dataset.title ?? ""} ${dataset.notes ?? ""} ${resource.name ?? ""} ${resource.description ?? ""} ${resource.format ?? ""}`),
      })),
  );
  resources.sort((a, b) => b.score - a.score);
  return { packages, resources };
}

async function importDataGovResource(env: Env, message: string, dataset: DataGovPackage, resource: DataGovResource) {
  if (!resource.url) throw new Error("Selected data.gov.uk resource has no URL.");
  const response = await fetch(resource.url, { headers: { "user-agent": "xlsx-song-agent-sandbox/1.0" } });
  if (!response.ok) throw new Error(`Resource download failed with ${response.status}`);

  const blob = await response.blob();
  const filename = filenameFromResource(resource, dataset);
  const file = new File([blob], filename, {
    type: response.headers.get("content-type") ?? "application/octet-stream",
  });
  if (!isSpreadsheetFile(file)) throw new Error(`Resource ${filename} is not a supported spreadsheet format.`);

  const formData = new FormData();
  formData.append("spreadsheet", file);
  formData.append("spreadsheetId", crypto.randomUUID());
  formData.append("preExtract", "true");
  formData.append("category", "data.gov.uk");

  const uploadResponse = await uploadSpreadsheet(new Request("https://internal.local/api/spreadsheets", { body: formData, method: "POST" }), env);
  if (!uploadResponse.ok) throw new Error((await uploadResponse.text()) || "Failed to import data.gov.uk resource.");
  const upload = (await uploadResponse.json()) as { spreadsheet?: SpreadsheetRow };
  const spreadsheetId = upload.spreadsheet?.id;
  if (!spreadsheetId) throw new Error("Imported spreadsheet id was not returned.");

  return getSpreadsheetRow(env, spreadsheetId);
}

async function answerImportedDatasetRequest(request: Request, env: Env) {
  const body = (await request.json().catch(() => ({}))) as DatasetAgentPendingPayload;
  if (typeof body.message !== "string" || !body.message.trim()) {
    return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
  }
  if (typeof body.spreadsheetId !== "string" || !body.spreadsheetId.trim()) {
    return json({ error: "Send JSON with a non-empty 'spreadsheetId' string." }, { status: 400 });
  }

  let selectedModel: ModelEntry | undefined;
  try {
    selectedModel = requestedModelEntry(env, body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid model." }, { status: 400 });
  }

  const message = body.message.trim();
  const spreadsheet = await getSpreadsheetRow(env, body.spreadsheetId.trim());
  if (!spreadsheet) return json({ error: "Spreadsheet not found." }, { status: 404 });

  if (spreadsheet.status === "processing") {
    return json({
      agentName: spreadsheet.agent_name,
      finishReason: "import_pending",
      importedSpreadsheet: { filename: spreadsheet.filename, id: spreadsheet.id },
      model: modelConfig(env, selectedModel),
      requestId: crypto.randomUUID(),
      response: `I am still processing ${spreadsheet.filename}. I will answer this question as soon as the dataset is ready.`,
      selectedSpreadsheet: { filename: spreadsheet.filename, id: spreadsheet.id, reason: "Imported from data.gov.uk and still processing.", score: null },
      steps: [{ detail: { filename: spreadsheet.filename, id: spreadsheet.id }, status: "running", title: "Processing imported dataset" }],
      usage: null,
    });
  }

  if (spreadsheet.status === "failed") {
    return json({
      agentName: spreadsheet.agent_name,
      error: spreadsheet.error_message ?? "Imported dataset processing failed.",
      finishReason: "import_failed",
      importedSpreadsheet: { filename: spreadsheet.filename, id: spreadsheet.id },
      model: modelConfig(env, selectedModel),
      requestId: crypto.randomUUID(),
      response: `Sorry, I imported ${spreadsheet.filename}, but processing failed before I could answer.`,
      selectedSpreadsheet: { filename: spreadsheet.filename, id: spreadsheet.id, reason: "Imported from data.gov.uk, but processing failed.", score: null },
      steps: [{ detail: spreadsheet.error_message ?? "Processing failed.", status: "error", title: "Imported dataset processing failed" }],
      usage: null,
    });
  }

  const answer = await fetchAgentMessageData(env, spreadsheet.agent_name, message, selectedModel);
  const data = answer.data && typeof answer.data === "object" ? answer.data : { response: answer.data };
  const responseText = typeof (data as { response?: unknown }).response === "string" ? (data as { response: string }).response : "";
  return json(
    {
      ...data,
      response: responseText,
      importedSpreadsheet: { filename: spreadsheet.filename, id: spreadsheet.id },
      selectedSpreadsheet: { filename: spreadsheet.filename, id: spreadsheet.id, reason: "Imported from data.gov.uk and answered after processing completed.", score: null },
      steps: [{ detail: { filename: spreadsheet.filename, id: spreadsheet.id }, status: "done", title: "Imported dataset ready" }],
    },
    { status: answer.status },
  );
}

async function sendDatasetAgentRequest(request: Request, env: Env) {
  const body = (await request.json().catch(() => ({}))) as DatasetAgentRequestPayload;
  if (typeof body.message !== "string" || !body.message.trim()) {
    return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
  }
  let selectedModel: ModelEntry | undefined;
  try {
    selectedModel = requestedModelEntry(env, body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid model." }, { status: 400 });
  }

  const message = body.message.trim();
  const steps: Array<{ detail?: unknown; status: "done" | "error" | "running"; title: string }> = [];
  const startedAt = Date.now();

  try {
    steps.push({ status: "running", title: "Searching local Data Library" });
    const local = await searchLocalDataset(env, message);
    const localThreshold = local.candidates.length === 1 ? 0.18 : 0.25;

    if (local.match && local.match.score >= localThreshold) {
      const spreadsheet = await getSpreadsheetRow(env, local.match.candidate.id);
      if (!spreadsheet) throw new Error("Local dataset match could not be loaded.");
      steps[steps.length - 1] = {
        detail: { filename: spreadsheet.filename, score: local.match.score },
        status: "done",
        title: "Found relevant local dataset",
      };
      const answer = await fetchAgentMessageData(env, spreadsheet.agent_name, message, selectedModel);
      const data = answer.data && typeof answer.data === "object" ? answer.data : { response: answer.data };
      const responseText = typeof (data as { response?: unknown }).response === "string" ? (data as { response: string }).response : "";
      return json(
        {
          ...data,
          response: `I found an existing local dataset that looks relevant: ${spreadsheet.filename}. I used that rather than searching data.gov.uk.\n\n${responseText}`,
          selectedSpreadsheet: { filename: spreadsheet.filename, id: spreadsheet.id, reason: "Matched an existing local dataset.", score: local.match.score },
          selection: {
            candidates: local.candidates,
            durationMs: 0,
            model: modelConfig(env, selectedModel),
            reason: "Matched an existing local dataset before searching data.gov.uk.",
            score: local.match.score,
            usage: null,
          },
          steps,
          totalDurationMs: Date.now() - startedAt,
        },
        { status: answer.status },
      );
    }

    steps[steps.length - 1] = {
      detail: { candidates: local.candidates.length, bestScore: local.match?.score ?? null },
      status: "done",
      title: "No strong local match",
    };
    steps.push({ status: "running", title: "Searching data.gov.uk" });
    const external = await searchDataGov(message);
    const best = external.resources[0];
    if (!best) {
      steps[steps.length - 1] = { detail: { datasets: external.packages.length }, status: "error", title: "No usable data.gov.uk file found" };
      return json({
        agentName: "dataset-agent",
        finishReason: "no_dataset",
        model: modelConfig(env, selectedModel),
        requestId: crypto.randomUUID(),
        response: "Sorry, I could not find a relevant local dataset or a usable spreadsheet file on data.gov.uk for that question.",
        steps,
        totalDurationMs: Date.now() - startedAt,
        usage: null,
      });
    }

    steps[steps.length - 1] = {
      detail: { dataset: best.dataset.title, resource: best.resource.name, score: best.score },
      status: "done",
      title: "Found data.gov.uk resource",
    };
    steps.push({ status: "running", title: "Importing data.gov.uk file" });
    const imported = await importDataGovResource(env, message, best.dataset, best.resource);
    if (!imported) throw new Error("Imported spreadsheet could not be loaded.");
    if (imported.status !== "ready") {
      const isFailed = imported?.status === "failed";
      steps[steps.length - 1] = {
        detail: { error: imported?.error_message ?? null, status: imported?.status ?? "unknown" },
        status: isFailed ? "error" : "running",
        title: isFailed ? "Imported dataset processing failed" : "Imported dataset processing in background",
      };
      return json({
        agentName: imported.agent_name,
        ...(isFailed ? { error: imported.error_message ?? "Imported dataset processing failed." } : {}),
        finishReason: isFailed ? "import_failed" : "import_pending",
        importedSpreadsheet: { filename: imported.filename, id: imported.id },
        model: modelConfig(env, selectedModel),
        requestId: crypto.randomUUID(),
        response: isFailed
          ? `I found and imported ${best.dataset.title ?? best.resource.name ?? "a data.gov.uk dataset"}, but processing failed before I could answer.`
          : `I found and imported ${best.dataset.title ?? best.resource.name ?? "a data.gov.uk dataset"}. I am processing it in the background and will answer when it is ready.`,
        selectedSpreadsheet: { filename: imported.filename, id: imported.id, reason: "Imported from data.gov.uk.", score: best.score },
        steps,
        totalDurationMs: Date.now() - startedAt,
        usage: null,
      });
    }

    steps[steps.length - 1] = { detail: { filename: imported.filename, id: imported.id }, status: "done", title: "Imported dataset and created agent" };
    const answer = await fetchAgentMessageData(env, imported.agent_name, message, selectedModel);
    const data = answer.data && typeof answer.data === "object" ? answer.data : { response: answer.data };
    const responseText = typeof (data as { response?: unknown }).response === "string" ? (data as { response: string }).response : "";
    return json(
      {
        ...data,
        response: `I could not find a strong local match, so I searched data.gov.uk and imported ${imported.filename}. I created a dataset agent for it and used that to answer.\n\n${responseText}`,
        importedSpreadsheet: { filename: imported.filename, id: imported.id },
        selectedSpreadsheet: { filename: imported.filename, id: imported.id, reason: "Imported from data.gov.uk after no strong local match.", score: best.score },
        selection: {
          candidates: external.resources.slice(0, 5).map((item) => ({
            columns: [],
            description: item.dataset.notes ?? item.resource.description ?? null,
            filename: item.resource.name ?? item.dataset.title ?? item.resource.url ?? "data.gov.uk resource",
            id: item.resource.id ?? item.dataset.id ?? item.resource.url ?? "data-gov-resource",
            rowCount: 0,
            status: item.resource.format ?? "resource",
            tables: [],
            updatedAt: item.resource.last_modified ?? "",
          })),
          durationMs: 0,
          model: modelConfig(env, selectedModel),
          reason: "Imported the best matching data.gov.uk resource after local search did not find a strong match.",
          score: best.score,
          usage: null,
        },
        steps,
        totalDurationMs: Date.now() - startedAt,
      },
      { status: answer.status },
    );
  } catch (error) {
    steps.push({ detail: error instanceof Error ? error.message : String(error), status: "error", title: "Dataset agent failed" });
    return json(
      {
        error: error instanceof Error ? error.message : "Dataset agent failed.",
        response: "Sorry, I could not complete the dataset search and import workflow.",
        steps,
      },
      { status: 500 },
    );
  }
}

async function createSpeech(request: Request, env: Env) {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) return json({ error: "ELEVENLABS_API_KEY is not configured." }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as SpeechPayload;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return json({ error: "Send JSON with a non-empty 'text' string." }, { status: 400 });
  const language = cleanSpeechLanguage(body.language);
  const speechText = await translateSpeechText(text, language, env);

  const voiceId = env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
  const modelId = env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
  const outputFormat = env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128";
  const speechUrl = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`);
  speechUrl.searchParams.set("output_format", outputFormat);

  const response = await fetch(speechUrl, {
    body: JSON.stringify({
      model_id: modelId,
      text: speechText.slice(0, 5000),
    }),
    headers: {
      "content-type": "application/json",
      "xi-api-key": apiKey,
    },
    method: "POST",
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    return json({ error: errorText || "ElevenLabs speech generation failed." }, { status: response.status });
  }

  return new Response(response.body, {
    headers: {
      "cache-control": "no-store",
      "content-type": response.headers.get("content-type") || "audio/mpeg",
    },
    status: 200,
  });
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function benchmarkRunFromRow(row: BenchmarkRunRow) {
  return {
    id: row.id,
    answer: row.answer,
    answerSeconds: row.answer_seconds,
    error: row.error ?? undefined,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
    finishReason: row.finish_reason ?? undefined,
    inputTokens: row.input_tokens,
    modelName: row.model_name,
    modelProvider: row.model_provider,
    outputTokens: row.output_tokens,
    prompt: row.prompt,
    quality: row.quality,
    requestId: row.request_id ?? undefined,
    spreadsheetFilename: row.spreadsheet_filename,
    spreadsheetId: row.spreadsheet_id,
    timestamp: row.created_at,
    totalSeconds: row.total_seconds,
    totalTokens: row.total_tokens,
    uploadSeconds: row.upload_seconds,
  };
}

async function listBenchmarkRuns(env: Env) {
  const { results } = await env.DB.prepare(
    [
      "SELECT id, prompt, answer, error, model_provider, model_name, spreadsheet_id, spreadsheet_filename, request_id, finish_reason,",
      "answer_seconds, total_seconds, upload_seconds, input_tokens, output_tokens, total_tokens, quality, evidence_json, created_at",
      "FROM benchmark_runs",
      "ORDER BY created_at DESC",
      "LIMIT 500",
    ].join(" "),
  ).all<BenchmarkRunRow>();

  return json({ runs: (results ?? []).map(benchmarkRunFromRow) });
}

async function createBenchmarkRun(request: Request, env: Env) {
  const body = (await request.json().catch(() => ({}))) as BenchmarkRunPayload;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const spreadsheetId = typeof body.spreadsheetId === "string" && body.spreadsheetId.trim() ? body.spreadsheetId.trim() : "unresolved";
  if (!prompt) return json({ error: "Benchmark prompt is required." }, { status: 400 });

  const id = crypto.randomUUID();
  const evidenceJson = body.evidence === undefined ? null : JSON.stringify(body.evidence);
  await env.DB.prepare(
    [
      "INSERT INTO benchmark_runs",
      "(id, prompt, answer, error, model_provider, model_name, spreadsheet_id, spreadsheet_filename, request_id, finish_reason,",
      "answer_seconds, total_seconds, upload_seconds, input_tokens, output_tokens, total_tokens, quality, evidence_json)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ].join(" "),
  )
    .bind(
      id,
      prompt,
      typeof body.answer === "string" ? body.answer : "",
      stringOrNull(body.error),
      stringOrNull(body.modelProvider),
      stringOrNull(body.modelName),
      spreadsheetId,
      stringOrNull(body.spreadsheetFilename),
      stringOrNull(body.requestId),
      stringOrNull(body.finishReason),
      numberOrNull(body.answerSeconds) ?? 0,
      numberOrNull(body.totalSeconds) ?? 0,
      numberOrNull(body.uploadSeconds),
      numberOrNull(body.inputTokens),
      numberOrNull(body.outputTokens),
      numberOrNull(body.totalTokens),
      numberOrNull(body.quality),
      evidenceJson,
    )
    .run();

  const row = await env.DB.prepare(
    [
      "SELECT id, prompt, answer, error, model_provider, model_name, spreadsheet_id, spreadsheet_filename, request_id, finish_reason,",
      "answer_seconds, total_seconds, upload_seconds, input_tokens, output_tokens, total_tokens, quality, evidence_json, created_at",
      "FROM benchmark_runs WHERE id = ?",
    ].join(" "),
  )
    .bind(id)
    .first<BenchmarkRunRow>();

  return json({ run: row ? benchmarkRunFromRow(row) : null }, { status: 201 });
}

async function updateBenchmarkRun(request: Request, env: Env, runId: string) {
  const body = (await request.json().catch(() => ({}))) as { quality?: unknown };
  const quality = numberOrNull(body.quality);
  if (quality === null || quality < 1 || quality > 5) return json({ error: "Quality must be a number from 1 to 5." }, { status: 400 });

  await env.DB.prepare("UPDATE benchmark_runs SET quality = ? WHERE id = ?").bind(Math.round(quality), runId).run();
  return json({ ok: true });
}

async function deleteBenchmarkRun(env: Env, runId: string) {
  await env.DB.prepare("DELETE FROM benchmark_runs WHERE id = ?").bind(runId).run();
  return json({ ok: true });
}

async function deleteBenchmarkRuns(env: Env) {
  await env.DB.prepare("DELETE FROM benchmark_runs").run();
  return json({ ok: true });
}

async function selectSpreadsheetForPrompt(env: Env, message: string, selectedModel?: ModelEntry) {
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
    model: modelForEnv(env, selectedModel),
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

async function fetchAgentMessageData(env: Env, agentName: string, message: string, selectedModel?: ModelEntry, accessMode?: unknown) {
  let stub: DurableObjectStub;
  if (agentName.startsWith("agent-")) {
    stub = env.AgentThink.get(env.AgentThink.idFromName(agentName));
  } else {
    stub = env.SheetsThink.get(env.SheetsThink.idFromName(agentName));
  }
  const response = await stub.fetch("https://agent.local/api-request", {
    body: JSON.stringify({ accessMode, message, model: selectedModel }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const data = await response
    .clone()
    .json()
    .catch(async () => ({ error: await response.text() }));
  return { data, status: response.status };
}

async function sendAgentMessage(env: Env, agentName: string, message: string, selectedModel?: ModelEntry, accessMode?: unknown) {
  const { data, status } = await fetchAgentMessageData(env, agentName, message, selectedModel, accessMode);
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
  let selectedModel: ModelEntry | undefined;
  try {
    selectedModel = requestedModelEntry(env, body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid model." }, { status: 400 });
  }

  return sendAgentMessage(env, agent.agent_name, body.message, selectedModel);
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

async function downloadSpreadsheetFile(env: Env, spreadsheetId: string) {
  const spreadsheet = await getSpreadsheetRow(env, spreadsheetId);
  if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });

  const candidates: Array<{
    contentType: string;
    filename: string;
    r2Key: string | null;
  }> = [
    {
      contentType: spreadsheet.content_type,
      filename: spreadsheet.filename,
      r2Key: spreadsheet.r2_key,
    },
  ];

  const latestRevision = (
    await env.DB.prepare(
      [
        "SELECT filename, content_type, r2_key",
        "FROM spreadsheet_revisions",
        "WHERE spreadsheet_id = ?",
        "ORDER BY revision_number DESC",
        "LIMIT 1",
      ].join(" "),
    )
      .bind(spreadsheet.id)
      .first<{ content_type: string; filename: string; r2_key: string }>()
  ) ?? null;

  if (latestRevision) {
    candidates.push({
      contentType: latestRevision.content_type,
      filename: latestRevision.filename,
      r2Key: latestRevision.r2_key,
    });
  }

  for (const candidate of candidates) {
    if (!candidate.r2Key) continue;
    const object = await env.SPREADSHEETS.get(candidate.r2Key);
    if (!object) continue;

    const headers = new Headers();
    headers.set("Content-Type", candidate.contentType || object.httpMetadata?.contentType || "application/octet-stream");
    headers.set("Content-Length", String(object.size));
    headers.set("Content-Disposition", contentDispositionFilename(candidate.filename));
    return new Response(object.body, { headers });
  }

  const stub = env.SheetsThink.get(env.SheetsThink.idFromName(spreadsheet.agent_name));
  const agentResponse = await stub.fetch("https://agent.local/raw-file");
  if (agentResponse.ok) return agentResponse;

  return json({ error: "Spreadsheet file was not found in R2 or the sheet agent." }, { status: 404 });
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

    if (url.pathname === "/api/dataset-agent/request" && request.method === "POST") {
      return sendDatasetAgentRequest(request, env);
    }

    if (url.pathname === "/api/dataset-agent/pending-answer" && request.method === "POST") {
      return answerImportedDatasetRequest(request, env);
    }

    if (url.pathname === "/api/benchmarks/query" && request.method === "POST") {
      return sendBenchmarkQuery(request, env);
    }

    if (url.pathname === "/api/speech" && request.method === "POST") {
      return createSpeech(request, env);
    }

    if (url.pathname === "/api/benchmarks/runs" && request.method === "GET") {
      return listBenchmarkRuns(env);
    }

    if (url.pathname === "/api/benchmarks/runs" && request.method === "POST") {
      return createBenchmarkRun(request, env);
    }

    if (url.pathname === "/api/benchmarks/runs" && request.method === "DELETE") {
      return deleteBenchmarkRuns(env);
    }

    const benchmarkRunMatch = url.pathname.match(/^\/api\/benchmarks\/runs\/([^/]+)$/);
    if (benchmarkRunMatch && request.method === "PATCH") {
      return updateBenchmarkRun(request, env, benchmarkRunMatch[1]);
    }

    if (benchmarkRunMatch && request.method === "DELETE") {
      return deleteBenchmarkRun(env, benchmarkRunMatch[1]);
    }

    if (url.pathname === "/api/models" && request.method === "GET") {
      return listAvailableModels(env);
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

    const agentChatHistoryMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/chat-history$/);
    if (agentChatHistoryMatch && (request.method === "GET" || request.method === "DELETE")) {
      const agent = await getLibraryAgentRow(env, agentChatHistoryMatch[1]);
      if (!agent) return json({ error: "Agent not found" }, { status: 404 });
      const stub = env.AgentThink.get(env.AgentThink.idFromName(agent.agent_name));
      return stub.fetch("https://agent.local/chat-history", { method: request.method });
    }

    const agentReportMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/report$/);
    if (agentReportMatch && (request.method === "GET" || request.method === "POST")) {
      const agent = await getLibraryAgentRow(env, agentReportMatch[1]);
      if (!agent) return json({ error: "Agent not found" }, { status: 404 });
      if (agent.status !== "ready") return json({ error: `Agent is ${agent.status}. ${agent.error_message ?? ""}`.trim() }, { status: 409 });
      const stub = env.AgentThink.get(env.AgentThink.idFromName(agent.agent_name));
      return stub.fetch("https://agent.local/report", {
        body: request.method === "POST" ? await request.text() : undefined,
        headers: request.method === "POST" ? { "content-type": request.headers.get("content-type") ?? "application/json" } : undefined,
        method: request.method,
      });
    }

    const agentSongMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/song$/);
    if (agentSongMatch && (request.method === "GET" || request.method === "POST")) {
      const agent = await getLibraryAgentRow(env, agentSongMatch[1]);
      if (!agent) return json({ error: "Agent not found" }, { status: 404 });
      if (agent.status !== "ready") return json({ error: `Agent is ${agent.status}. ${agent.error_message ?? ""}`.trim() }, { status: 409 });
      const stub = env.AgentThink.get(env.AgentThink.idFromName(agent.agent_name));
      return stub.fetch("https://agent.local/song", {
        body: request.method === "POST" ? await request.text() : undefined,
        headers: request.method === "POST" ? { "content-type": request.headers.get("content-type") ?? "application/json" } : undefined,
        method: request.method,
      });
    }

    const agentSongAudioMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/song\/audio$/);
    if (agentSongAudioMatch && request.method === "GET") {
      const agent = await getLibraryAgentRow(env, agentSongAudioMatch[1]);
      if (!agent) return json({ error: "Agent not found" }, { status: 404 });
      const stub = env.AgentThink.get(env.AgentThink.idFromName(agent.agent_name));
      return stub.fetch("https://agent.local/song/audio");
    }

    const agentTablesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/tables$/);
    if (agentTablesMatch && request.method === "GET") {
      const agent = await getLibraryAgentRow(env, agentTablesMatch[1]);
      if (!agent) return json({ error: "Agent not found" }, { status: 404 });
      const stub = env.AgentThink.get(env.AgentThink.idFromName(agent.agent_name));
      return stub.fetch("https://agent.local/agent-database");
    }

    const publicAgentTablesMatch = url.pathname.match(/^\/public\/agents\/([^/]+)\/tables$/);
    if (publicAgentTablesMatch && request.method === "GET") {
      const agent = await getLibraryAgentRow(env, publicAgentTablesMatch[1]);
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

    const publicAgentTableMatch = url.pathname.match(/^\/public\/agents\/([^/]+)\/tables\/([^/]+)$/);
    if (publicAgentTableMatch && request.method === "GET") {
      const agent = await getLibraryAgentRow(env, publicAgentTableMatch[1]);
      if (!agent) return json({ error: "Agent not found" }, { status: 404 });
      const tableUrl = new URL("https://agent.local/agent-table");
      tableUrl.searchParams.set("table", decodeURIComponent(publicAgentTableMatch[2]));
      tableUrl.searchParams.set("public", "1");
      tableUrl.searchParams.set("agentId", publicAgentTableMatch[1]);
      tableUrl.searchParams.set("limit", url.searchParams.get("limit") ?? "");
      tableUrl.searchParams.set("offset", url.searchParams.get("offset") ?? "");
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

    const spreadsheetChatHistoryMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/chat-history$/);
    if (spreadsheetChatHistoryMatch && (request.method === "GET" || request.method === "DELETE")) {
      const spreadsheet = await getSpreadsheetRow(env, spreadsheetChatHistoryMatch[1]);
      if (!spreadsheet) return json({ error: "Spreadsheet not found" }, { status: 404 });
      const stub = env.SheetsThink.get(env.SheetsThink.idFromName(spreadsheet.agent_name));
      return stub.fetch("https://agent.local/chat-history", { method: request.method });
    }

    const spreadsheetRetryExtractionMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/retry-extraction$/);
    if (spreadsheetRetryExtractionMatch && request.method === "POST") {
      return retrySpreadsheetExtraction(env, spreadsheetRetryExtractionMatch[1]);
    }

    const spreadsheetFileMatch = url.pathname.match(/^\/api\/spreadsheets\/([^/]+)\/file$/);
    if (spreadsheetFileMatch && request.method === "GET") {
      return downloadSpreadsheetFile(env, spreadsheetFileMatch[1]);
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
