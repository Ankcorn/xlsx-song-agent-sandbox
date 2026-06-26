import { useAgent } from "agents/react";
import type { Spec } from "@json-render/core";
import { Badge, Banner, Button, Empty, Input, Loader, Table, Tabs } from "./components/ui";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  BarChart3,
  Clock,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  Gauge,
  History,
  Layers3,
  Music,
  PanelRightClose,
  PanelRightOpen,
  Mic,
  Plus,
  Send,
  Search,
  Star,
  Table2,
  Trash2,
  Upload,
  Volume2,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { JsonRenderReport } from "./jsonRender";
import "./styles.css";

type Spreadsheet = {
  id: string;
  filename: string;
  content_type: string;
  category: string;
  error_message?: string | null;
  pre_extract?: number;
  size_bytes: number;
  agent_name: string;
  status?: "processing" | "ready" | "failed";
  uploaded_at?: string;
};

type SpreadsheetResponse = {
  spreadsheet: Spreadsheet;
};

type SpreadsheetListResponse = {
  spreadsheets: Spreadsheet[];
};

type SpreadsheetRevision = {
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

type SpreadsheetRevisionsResponse = {
  revisions: SpreadsheetRevision[];
  spreadsheet: Spreadsheet;
};

type SpreadsheetRevisionUploadResponse = {
  revision: SpreadsheetRevision | null;
  spreadsheet: Spreadsheet | null;
};

type LibraryAgent = {
  id: string;
  name: string;
  description: string;
  agent_name: string;
  status?: "processing" | "ready" | "failed";
  error_message?: string | null;
  sheet_count?: number;
  created_at?: string;
  updated_at?: string;
};

type LibraryAgentListResponse = {
  agents: LibraryAgent[];
};

type LibraryAgentResponse = {
  agent: LibraryAgent;
  sheets: Spreadsheet[];
};

type AgentReport = {
  generatedAt: string;
  id: string;
  isStale?: boolean;
  latestDataUpdatedAt?: string | null;
  prompt: string;
  spec: unknown;
  title: string | null;
  updatedAt: string;
};

type AgentReportResponse = {
  report: AgentReport | null;
};

type AgentSong = {
  audioUrl: string;
  facts: string[];
  generatedAt: string;
  id: string;
  isStale?: boolean;
  latestDataUpdatedAt?: string | null;
  modelId: string;
  musicPrompt: string;
  outputFormat: string;
  prompt: string;
  title: string | null;
  updatedAt: string;
};

type AgentSongResponse = {
  song: AgentSong | null;
};

type AgentTrace = {
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

type AgentTraceResponse = {
  traces: AgentTrace[];
};

type AgentChatHistoryResponse = {
  messages: Array<{
    id: string;
    role: "assistant" | "user";
    text: string;
    created_at: string;
  }>;
};

type AgentTraceMessage = {
  type: "agent_trace";
  trace: AgentTrace;
};

type AnalysisTableSummary = {
  table_name: string;
  source_name: string;
  columns_json: string;
  row_count: number;
  columns: string[];
};

type AnalysisTablesResponse = {
  analysis: {
    spreadsheet_id: string;
    description: string;
    extraction_score: number;
    updated_at: string;
  } | null;
  metadata: Record<string, unknown> | null;
  tables: AnalysisTableSummary[];
};

type AnalysisTableResponse = {
  table: AnalysisTableSummary | null;
  columns: string[];
  rows: Record<string, unknown>[];
};

type RawPreviewSheet = {
  name: string;
  columns: number;
  rows: unknown[][];
};

type RawPreviewResponse = {
  filename: string;
  contentType: string;
  sizeBytes: number;
  preview: {
    format: string;
    sheets: RawPreviewSheet[];
  };
};

type AgentView = "chat" | "sqlite" | "raw" | "revisions";
type MultiAgentView = "chat" | "sqlite" | "sources";

type RenderedMessage = {
  benchmarkRun?: BenchmarkRun;
  benchmarkSaved?: boolean;
  benchmarkSaving?: boolean;
  id: string;
  role: string;
  text: string;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  start: () => void;
  stop: () => void;
};

type AgentRequestResponse = {
  agentName: string;
  finishReason?: string;
  importedSpreadsheet?: {
    filename: string;
    id: string;
  };
  model?: {
    fallbackModels?: Array<{ model: string; provider: string }>;
    gatewayId?: string;
    model?: string;
    provider?: string;
  };
  requestId: string;
  response: string;
  selectedSpreadsheet?: {
    filename: string;
    id: string;
    reason?: string;
    score?: number | null;
  };
  selection?: BenchmarkSelectionEvidence;
  steps?: DatasetAgentStep[];
  usage?: Record<string, unknown>;
};

type DatasetAgentStep = {
  detail?: unknown;
  status: "done" | "error" | "running";
  title: string;
};

type PendingDatasetAnswer = {
  answerStartedAt: number;
  messageId: string;
  prompt: string;
  spreadsheetFilename: string;
  spreadsheetId: string;
  totalStartedAt: number;
};

type BenchmarkSelectionCandidate = {
  columns?: string[];
  description?: string | null;
  filename: string;
  id: string;
  rowCount?: number;
  status?: string;
  tables?: Array<{
    columns?: string[];
    name: string;
    rowCount?: number;
    sourceName?: string;
  }>;
  updatedAt?: string;
};

type BenchmarkSelectionEvidence = {
  accessMode?: string | null;
  candidates?: BenchmarkSelectionCandidate[];
  durationMs?: number;
  estimatedCostUsd?: number | null;
  model?: {
    fallbackModels?: Array<{ model: string; provider: string }>;
    gatewayId?: string;
    model?: string;
    provider?: string;
  };
  reason?: string;
  score?: number | null;
  usage?: Record<string, unknown> | null;
};

type AiModelOption = {
  model: string;
  provider: string;
};

type BenchmarkRun = {
  id: string;
  answer: string;
  answerSeconds: number;
  error?: string;
  evidence?: BenchmarkSelectionEvidence | null;
  finishReason?: string;
  inputTokens: number | null;
  modelName: string | null;
  modelProvider: string | null;
  prompt: string;
  quality: number | null;
  requestId?: string;
  spreadsheetFilename: string | null;
  spreadsheetId: string;
  timestamp: string;
  totalSeconds: number;
  totalTokens: number | null;
  uploadSeconds: number | null;
  outputTokens: number | null;
};

type BenchmarkRunsResponse = {
  runs: BenchmarkRun[];
};

type BenchmarkRunResponse = {
  run: BenchmarkRun | null;
};

type LibraryGroupMode = "category" | "status" | "extraction" | "type";

function textFromMessage(message: unknown) {
  if (typeof message !== "object" || message === null) return "";
  const candidate = message as {
    content?: unknown;
    parts?: unknown;
    text?: unknown;
  };

  if (typeof candidate.text === "string") return candidate.text;
  if (typeof candidate.content === "string") return candidate.content;

  if (!Array.isArray(candidate.parts)) return "";

  return candidate.parts
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const typedPart = part as {
        content?: unknown;
        text?: unknown;
        type?: unknown;
      };
      if (typeof typedPart.text === "string") return typedPart.text;
      if (typeof typedPart.content === "string") return typedPart.content;
      return "";
    })
    .join("");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTraceDetail(detail: string | null) {
  if (!detail) return null;

  try {
    const parsed = JSON.parse(detail) as unknown;
    if (typeof parsed === "string") return parsed;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return detail;
  }
}

function traceDetailParts(detail: string | null) {
  if (!detail) return { raw: null, snippet: null, summary: null };

  try {
    const parsed = JSON.parse(detail) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      return {
        raw: JSON.stringify(parsed, null, 2),
        snippet: typeof record.snippet === "string" ? record.snippet : null,
        summary: typeof record.summary === "string" ? record.summary : null,
      };
    }
    if (typeof parsed === "string") return { raw: parsed, snippet: null, summary: parsed };
    return { raw: String(parsed), snippet: null, summary: null };
  } catch {
    return { raw: detail, snippet: null, summary: detail };
  }
}

function parseTraceDetail(detail: string | null) {
  if (!detail) return null;
  try {
    return JSON.parse(detail) as unknown;
  } catch {
    return detail;
  }
}

function traceSummary(detail: string | null) {
  const parsed = parseTraceDetail(detail);
  if (typeof parsed === "string") return parsed;
  if (typeof parsed === "object" && parsed !== null && "summary" in parsed) {
    const summary = (parsed as Record<string, unknown>).summary;
    return typeof summary === "string" ? summary : null;
  }
  return null;
}

function traceKeyValues(trace: AgentTrace) {
  const parsed = parseTraceDetail(trace.detail);
  const base: Array<[string, string]> = [
    ["Status", trace.status],
    ["Component", trace.span_type],
    ["Step", trace.step_number === null ? "Unnumbered" : String(trace.step_number)],
    ["Started", formatTraceTime(trace.created_at)],
    ["Duration", formatDuration(trace.duration_ms)],
  ];
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === "summary" || key === "snippet") continue;
      if (value === null || value === undefined || typeof value === "object") continue;
      base.push([humanizeTraceKey(key), String(value)]);
    }
  }
  return base.slice(0, 10);
}

function tracePayload(trace: AgentTrace) {
  const parsed = parseTraceDetail(trace.detail);
  if (parsed === null) return "No payload captured for this event.";
  if (typeof parsed === "string") return parsed;
  return JSON.stringify(parsed, null, 2);
}

function tracePayloadSections(trace: AgentTrace) {
  const parsed = parseTraceDetail(trace.detail);
  if (parsed === null) return { compact: [] as Array<[string, string]>, raw: "No payload captured for this event.", sections: [] as Array<[string, unknown]> };
  const detail = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  const snippet = detail && typeof detail.snippet === "string" ? parseTraceSnippet(detail.snippet) : undefined;
  const source = snippet && typeof snippet === "object" && snippet !== null ? (snippet as Record<string, unknown>) : detail;
  const compact: Array<[string, string]> = [];
  const sections: Array<[string, unknown]> = [];

  if (detail && typeof detail.summary === "string") compact.push(["Summary", detail.summary]);
  if (typeof parsed === "string") compact.push(["Message", parsed]);

  if (source) {
    for (const [key, value] of Object.entries(source)) {
      if (key === "summary" || key === "snippet") continue;
      if (value === null || value === undefined) continue;
      if (isTraceCodeKey(key) && typeof value === "string") {
        sections.push([key, value]);
        continue;
      }
      if (typeof value === "object") sections.push([key, value]);
      else compact.push([humanizeTraceKey(key), String(value)]);
    }
  } else if (snippet !== undefined) {
    if (typeof snippet === "string" && looksLikePythonCode(snippet)) sections.push(["code", snippet]);
    else compact.push(["Snippet", typeof snippet === "string" ? snippet : JSON.stringify(snippet, null, 2)]);
  }

  if (detail && source !== detail) {
    for (const [key, value] of Object.entries(detail)) {
      if (key === "summary" || key === "snippet" || value === null || value === undefined) continue;
      if (isTraceCodeKey(key) && typeof value === "string") {
        sections.push([key, value]);
        continue;
      }
      if (typeof value === "object") sections.push([key, value]);
      else if (!compact.some(([label]) => label === humanizeTraceKey(key))) compact.push([humanizeTraceKey(key), String(value)]);
    }
  }

  return {
    compact: compact.slice(0, 12),
    raw: typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2),
    sections: prioritizeTraceSections(sections),
  };
}

function parseTraceSnippet(snippet: string) {
  try {
    return JSON.parse(snippet) as unknown;
  } catch {
    return snippet;
  }
}

function isTraceCodeKey(key: string) {
  return ["code", "python", "script", "generated_code", "extractor_code"].includes(key.toLowerCase());
}

function looksLikePythonCode(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !trimmed.includes("\n")) return false;
  return (
    /^import\s+/m.test(trimmed) ||
    /^from\s+\S+\s+import\s+/m.test(trimmed) ||
    /^def\s+\w+\(/m.test(trimmed) ||
    /^class\s+\w+/m.test(trimmed) ||
    /json\.dumps\(/.test(trimmed) ||
    /SPREADSHEET_PATH/.test(trimmed)
  );
}

function prioritizeTraceSections(sections: Array<[string, unknown]>) {
  const bulky = new Set(["profile", "sheets", "sample", "useful_sample", "preview"]);
  return [...sections].sort(([left], [right]) => {
    const leftCode = isTraceCodeKey(left) ? -1 : 0;
    const rightCode = isTraceCodeKey(right) ? -1 : 0;
    if (leftCode !== rightCode) return leftCode - rightCode;
    return Number(bulky.has(left)) - Number(bulky.has(right));
  });
}

function TracePayloadView({ trace }: { trace: AgentTrace }) {
  const payload = tracePayloadSections(trace);
  return (
    <div className="trace-payload-panel">
      <div className="trace-payload-header">
        <h3>Payload</h3>
        <span>Structured</span>
      </div>
      <div className="trace-payload-body">
        {payload.compact.length > 0 ? (
          <dl className="trace-payload-summary">
            {payload.compact.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {payload.sections.length > 0 ? (
          <div className="trace-payload-sections">
            {payload.sections.map(([key, value], index) => (
              <details key={`${key}-${index}`} open={index === 0 && !isBulkyTraceSection(key)}>
                <summary>
                  <span>{humanizeTraceKey(key)}</span>
                  <small>{traceSectionSummary(value)}</small>
                </summary>
                <pre className={isTraceCodeKey(key) && typeof value === "string" ? "trace-payload-code" : undefined}>
                  {isTraceCodeKey(key) && typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        ) : null}
        {payload.compact.length === 0 && payload.sections.length === 0 ? <pre>{payload.raw}</pre> : null}
      </div>
    </div>
  );
}

function isBulkyTraceSection(key: string) {
  return ["profile", "sheets", "sample", "useful_sample", "preview"].includes(key);
}

function traceSectionSummary(value: unknown) {
  if (typeof value === "string" && looksLikePythonCode(value)) return `${value.split("\n").length} lines`;
  if (Array.isArray(value)) return `${value.length} items`;
  if (value && typeof value === "object") return `${Object.keys(value).length} keys`;
  return typeof value;
}

function humanizeTraceKey(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTraceTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(value: number | null) {
  if (value === null) return "—";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} s`;
}

function isAgentTraceMessage(value: unknown): value is AgentTraceMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "agent_trace" &&
    "trace" in value
  );
}

function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeDownloadName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function extractionLabel(spreadsheet: Spreadsheet) {
  return spreadsheet.pre_extract === 0 ? "Just uploaded" : "Pre-extracted";
}

function contentTypeLabel(contentType: string) {
  if (contentType.includes("csv")) return "CSV";
  if (contentType.includes("spreadsheet") || contentType.includes("excel") || contentType.includes("sheet")) return "Spreadsheet";
  if (contentType.includes("xml")) return "XML";
  return contentType || "Unknown";
}

function spreadsheetGroupLabel(spreadsheet: Spreadsheet, groupMode: LibraryGroupMode) {
  if (groupMode === "status") return spreadsheet.status ?? "ready";
  if (groupMode === "extraction") return extractionLabel(spreadsheet);
  if (groupMode === "type") return contentTypeLabel(spreadsheet.content_type);
  return spreadsheet.category || "Uncategorised";
}

function statusVariant(status?: Spreadsheet["status"]) {
  if (status === "ready") return "success";
  if (status === "failed") return "error";
  return "warning";
}

function cellText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function parseJsonRenderSpec(text: string): Spec | null {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "root" in parsed &&
        "elements" in parsed &&
        typeof (parsed as { root?: unknown }).root === "string" &&
        typeof (parsed as { elements?: unknown }).elements === "object"
      ) {
        return parsed as Spec;
      }
    } catch {
      // Continue to the next candidate.
    }
  }

  return null;
}

function isJsonRenderSpec(value: unknown): value is Spec {
  return (
    typeof value === "object" &&
    value !== null &&
    "root" in value &&
    "elements" in value &&
    typeof (value as { root?: unknown }).root === "string" &&
    typeof (value as { elements?: unknown }).elements === "object"
  );
}

function isJsonRenderStreamCandidate(text: string) {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("```json") || trimmed.startsWith("```");
}

function textFromUnknown(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function compactSpeechText(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[{}[\]"`]/g, " ")
    .replace(/\b(root|elements|props|component|children|metadata|payload|json)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectSpecSpeechFacts(value: unknown, facts: string[] = []) {
  if (facts.length >= 10 || value === null || value === undefined) return facts;

  if (Array.isArray(value)) {
    for (const item of value) collectSpecSpeechFacts(item, facts);
    return facts;
  }

  if (typeof value !== "object") return facts;
  const record = value as Record<string, unknown>;
  const component = textFromUnknown(record.component ?? record.type);
  const props = typeof record.props === "object" && record.props !== null ? (record.props as Record<string, unknown>) : record;

  if (/^(Heading|Text|Alert)$/i.test(component)) {
    const text = textFromUnknown(props.text ?? props.title ?? props.description);
    if (text) facts.push(text);
  }

  if (/StatGrid/i.test(component) && Array.isArray(props.items)) {
    for (const item of props.items.slice(0, 4)) {
      if (typeof item !== "object" || item === null) continue;
      const stat = item as Record<string, unknown>;
      const label = textFromUnknown(stat.label);
      const valueText = textFromUnknown(stat.value);
      const delta = textFromUnknown(stat.delta);
      if (label && valueText) facts.push(`${label}: ${valueText}${delta ? `, ${delta}` : ""}`);
    }
  }

  if (/BarChart/i.test(component) && Array.isArray(props.data)) {
    const title = textFromUnknown(props.title);
    const top = props.data
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .slice(0, 3)
      .map((item) => {
        const label = textFromUnknown(item.label);
        const numberValue = typeof item.value === "number" ? item.value.toLocaleString() : textFromUnknown(item.value);
        return label && numberValue ? `${label} ${numberValue}` : "";
      })
      .filter(Boolean);
    if (top.length) facts.push(`${title || "Top values"}: ${top.join("; ")}`);
  }

  if (/DataTable/i.test(component) && Array.isArray(props.rows)) {
    const rows = props.rows.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null).slice(0, 3);
    const rowFacts = rows
      .map((row) =>
        Object.entries(row)
          .filter(([, item]) => typeof item === "string" || typeof item === "number")
          .slice(0, 3)
          .map(([key, item]) => `${key}: ${item}`)
          .join(", "),
      )
      .filter(Boolean);
    if (rowFacts.length) facts.push(`Table highlights: ${rowFacts.join("; ")}`);
  }

  for (const item of Object.values(record)) collectSpecSpeechFacts(item, facts);
  return facts;
}

function speechSummaryForMessage(text: string) {
  const spec = parseJsonRenderSpec(text);
  if (spec) {
    const facts = Array.from(new Set(collectSpecSpeechFacts(spec).map(compactSpeechText).filter(Boolean)));
    const summary = facts.slice(0, 5).join(". ").slice(0, 700);
    if (summary) return summary;
  }

  const compact = compactSpeechText(text);
  const sentences = compact
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !/^(assistant|user|metadata|payload)$/i.test(sentence));
  const factHeavy = sentences.filter((sentence) => /\d|%|£|\$|€|count|total|average|highest|lowest|top|bottom|increase|decrease/i.test(sentence));
  return (factHeavy.length ? factHeavy : sentences).slice(0, 3).join(" ").slice(0, 600) || compact.slice(0, 600);
}

function ChatMessage({
  isStreaming = false,
  message,
  onAddToBenchmark,
}: {
  isStreaming?: boolean;
  message: RenderedMessage;
  onAddToBenchmark?: (messageId: string) => void;
}) {
  const spec = message.role === "assistant" ? parseJsonRenderSpec(message.text) : null;
  const isRenderingJson = message.role === "assistant" && isStreaming && !spec && isJsonRenderStreamCandidate(message.text);
  const canBenchmark = message.role === "assistant" && Boolean(message.benchmarkRun) && !isStreaming;
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const canSpeak = message.role === "assistant" && !isStreaming && message.text.trim().length > 0;

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function speakMessage() {
    if (!canSpeak || isSpeaking) return;
    setSpeechError(null);
    setIsSpeaking(true);

    try {
      audioRef.current?.pause();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);

      const response = await fetch("/api/speech", {
        body: JSON.stringify({ text: speechSummaryForMessage(message.text) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || "Speech generation failed.");
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      objectUrlRef.current = objectUrl;
      audio.onended = () => setIsSpeaking(false);
      audio.onerror = () => {
        setSpeechError("Could not play generated speech.");
        setIsSpeaking(false);
      };
      await audio.play();
    } catch (caught) {
      setSpeechError(caught instanceof Error ? caught.message : "Speech generation failed.");
      setIsSpeaking(false);
    }
  }

  return (
    <article className={`message ${message.role}`}>
      <div className="message-header">
        <span>{message.role}</span>
        {canSpeak ? (
          <button
            aria-label={isSpeaking ? "Playing speech" : "Play speech"}
            className="speech-button"
            disabled={isSpeaking}
            title={isSpeaking ? "Playing speech" : "Play speech"}
            type="button"
            onClick={() => void speakMessage()}
          >
            {isSpeaking ? <Loader size="sm" /> : <Volume2 size={15} />}
          </button>
        ) : null}
      </div>
      {isStreaming && message.text === "Thinking..." ? (
        <div className="json-render-loading">
          <Loader size="sm" />
          <div>
            <strong>Thinking...</strong>
          </div>
        </div>
      ) : spec ? (
        <div className="json-render-message">
          <JsonRenderReport spec={spec} />
        </div>
      ) : isRenderingJson ? (
        <div className="json-render-loading">
          <Loader size="sm" />
          <div>
            <strong>Rendering answer</strong>
            <p>Building the interactive report...</p>
          </div>
        </div>
      ) : (
        <p>{message.text}</p>
      )}
      {canBenchmark || canSpeak ? (
        <div className="message-actions">
          {canSpeak ? (
            <Button
              disabled={isSpeaking}
              icon={isSpeaking ? <Loader size="sm" /> : <Volume2 size={15} />}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => void speakMessage()}
            >
              {isSpeaking ? "Speaking" : "Speak"}
            </Button>
          ) : null}
          {canBenchmark ? (
            <Button
              disabled={message.benchmarkSaved || message.benchmarkSaving}
              icon={<BarChart3 size={15} />}
              loading={message.benchmarkSaving}
              size="sm"
              type="button"
              variant={message.benchmarkSaved ? "secondary" : "primary"}
              onClick={() => onAddToBenchmark?.(message.id)}
            >
              {message.benchmarkSaved ? "Added to benchmark" : "Add to benchmark"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {speechError ? <p className="speech-error">{speechError}</p> : null}
    </article>
  );
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function VoiceInputButton({
  disabled,
  onTranscript,
  value,
}: {
  disabled?: boolean;
  onTranscript: (value: string) => void;
  value: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  function startListening() {
    if (disabled || isListening) return;
    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      setError("Voice input is not supported in this browser.");
      return;
    }

    setError(null);
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .flatMap((result) => Array.from(result).map((item) => item.transcript))
        .join(" ")
        .trim();
      if (transcript) onTranscript([value.trim(), transcript].filter(Boolean).join(" "));
    };
    recognition.onerror = (event) => {
      setError(event.error === "not-allowed" ? "Microphone permission was blocked." : "Voice input failed.");
      setIsListening(false);
    };
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.start();
  }

  return (
    <div className="voice-input-control">
      <Button
        aria-label={isListening ? "Listening for voice input" : "Start voice input"}
        className={isListening ? "voice-input-button is-listening" : "voice-input-button"}
        disabled={disabled}
        icon={<Mic size={18} />}
        loading={isListening}
        shape="square"
        title={isListening ? "Listening" : "Dictate message"}
        type="button"
        variant="secondary"
        onClick={startListening}
      />
      {error ? <span>{error}</span> : null}
    </div>
  );
}

function formatSeconds(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return "n/a";
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  return `${seconds.toFixed(1)}s`;
}

function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined ? "n/a" : value.toLocaleString();
}

function aiModelLabel(model: AiModelOption | null | undefined) {
  if (!model) return "Loading models";
  return `${model.provider} · ${model.model}`;
}

function benchmarkAccessMode(run: BenchmarkRun) {
  const accessMode = run.evidence?.accessMode;
  return typeof accessMode === "string" && accessMode ? accessMode : "auto";
}

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function average(values: Array<number | null | undefined>) {
  const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (filtered.length === 0) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function tokenCount(usage: Record<string, unknown> | undefined, keys: string[]) {
  if (!usage) return null;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  }
  return null;
}

function createBenchmarkRunFromAnswer(input: {
  answer: AgentRequestResponse;
  answerSeconds: number;
  prompt: string;
  spreadsheetFilename: string | null;
  spreadsheetId: string;
  totalSeconds: number;
  uploadSeconds: number | null;
}) {
  const inputTokens = tokenCount(input.answer.usage, ["inputTokens", "promptTokens", "prompt_tokens", "input_tokens"]);
  const outputTokens = tokenCount(input.answer.usage, ["outputTokens", "completionTokens", "completion_tokens", "output_tokens"]);
  const reportedTotalTokens = tokenCount(input.answer.usage, ["totalTokens", "total_tokens"]);
  const totalTokens = reportedTotalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);

  return {
    id: crypto.randomUUID(),
    answer: input.answer.response,
    answerSeconds: input.answerSeconds,
    evidence:
      input.answer.selection ??
      {
        candidates: input.spreadsheetId
          ? [
              {
                filename: input.spreadsheetFilename ?? input.spreadsheetId,
                id: input.spreadsheetId,
              },
            ]
          : [],
        model: input.answer.model,
        reason: input.answer.selectedSpreadsheet?.reason ?? "Spreadsheet chat request used the current spreadsheet, so semantic spreadsheet selection was skipped.",
        score: input.answer.selectedSpreadsheet?.score ?? null,
        usage: input.answer.usage,
      },
    finishReason: input.answer.finishReason,
    inputTokens,
    modelName: input.answer.model?.model ?? null,
    modelProvider: input.answer.model?.provider ?? null,
    outputTokens,
    prompt: input.prompt,
    quality: null,
    requestId: input.answer.requestId,
    spreadsheetFilename: input.answer.selectedSpreadsheet?.filename ?? input.spreadsheetFilename,
    spreadsheetId: input.answer.selectedSpreadsheet?.id ?? input.spreadsheetId,
    timestamp: new Date().toISOString(),
    totalSeconds: input.totalSeconds,
    totalTokens,
    uploadSeconds: input.uploadSeconds,
  } satisfies BenchmarkRun;
}

async function saveBenchmarkRun(run: BenchmarkRun) {
  const data = await fetchJson<BenchmarkRunResponse>("/api/benchmarks/runs", {
    body: JSON.stringify(run),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  window.dispatchEvent(new CustomEvent("benchmark-runs-updated"));
  return data.run ?? run;
}

async function updateBenchmarkRunQuality(runId: string, quality: number) {
  await fetchJson<{ ok: true }>(`/api/benchmarks/runs/${runId}`, {
    body: JSON.stringify({ quality }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  window.dispatchEvent(new CustomEvent("benchmark-runs-updated"));
}

async function deleteBenchmarkRun(runId: string) {
  await fetchJson<{ ok: true }>(`/api/benchmarks/runs/${runId}`, { method: "DELETE" });
  window.dispatchEvent(new CustomEvent("benchmark-runs-updated"));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

async function waitForSpreadsheetExtraction(spreadsheetId: string) {
  const startedAt = Date.now();
  const timeoutMs = 8 * 60 * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    const data = await fetchJson<SpreadsheetResponse>(`/api/spreadsheets/${spreadsheetId}`);
    if (data.spreadsheet.status === "ready" || data.spreadsheet.status === "failed") return data.spreadsheet;
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }

  throw new Error("Pre-extraction is still running. Open this spreadsheet from the list to continue watching it.");
}

function RootLayout() {
  const location = useLocation();
  const isPublicReport = /^\/agents\/[^/]+\/report\/?$/.test(location.pathname);
  return (
    <main className={isPublicReport ? "page-shell report-shell" : "page-shell"}>
      {isPublicReport ? null : (
        <nav className="app-nav">
          <Link to="/" className="brand">
            <FileSpreadsheet size={22} />
            <span>XLSX Song</span>
          </Link>
          <div className="nav-actions">
            <Link to="/ask" className="nav-button">
              <Search size={18} />
              <span>Ask data</span>
            </Link>
            <Link to="/upload" className="nav-button">
              <Plus size={18} />
              <span>Upload</span>
            </Link>
            <Link to="/agents" className="nav-button">
              <Bot size={18} />
              <span>Agents</span>
            </Link>
            <Link to="/benchmarks" className="nav-button">
              <BarChart3 size={18} />
              <span>Benchmarks</span>
            </Link>
          </div>
        </nav>
      )}
      <Outlet />
    </main>
  );
}

function SpreadsheetListPage() {
  const navigate = useNavigate();
  const [spreadsheets, setSpreadsheets] = useState<Spreadsheet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [groupMode, setGroupMode] = useState<LibraryGroupMode>("category");
  const filteredSpreadsheets = spreadsheets.filter((spreadsheet) => {
    const haystack = [
      spreadsheet.filename,
      spreadsheet.category,
      spreadsheet.content_type,
      spreadsheet.agent_name,
      spreadsheet.status,
      extractionLabel(spreadsheet),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const groupedSpreadsheets = filteredSpreadsheets.reduce<Array<{ label: string; items: Spreadsheet[] }>>((groups, spreadsheet) => {
    const label = spreadsheetGroupLabel(spreadsheet, groupMode);
    const group = groups.find((item) => item.label === label);
    if (group) group.items.push(spreadsheet);
    else groups.push({ label, items: [spreadsheet] });
    return groups;
  }, []);
  const readyCount = spreadsheets.filter((spreadsheet) => spreadsheet.status === "ready" || !spreadsheet.status).length;
  const failedCount = spreadsheets.filter((spreadsheet) => spreadsheet.status === "failed").length;
  const preExtractedCount = spreadsheets.filter((spreadsheet) => spreadsheet.pre_extract !== 0).length;

  useEffect(() => {
    fetchJson<SpreadsheetListResponse>("/api/spreadsheets")
      .then((data) => setSpreadsheets(data.spreadsheets))
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setIsLoading(false));
  }, []);

  async function retryExtraction(spreadsheetId: string) {
    if (retryingId) return;
    setRetryingId(spreadsheetId);
    setError(null);
    setSpreadsheets((current) =>
      current.map((spreadsheet) =>
        spreadsheet.id === spreadsheetId ? { ...spreadsheet, error_message: null, pre_extract: 1, status: "processing" } : spreadsheet,
      ),
    );

    try {
      const data = await fetchJson<SpreadsheetResponse>(`/api/spreadsheets/${spreadsheetId}/retry-extraction`, {
        method: "POST",
      });
      setSpreadsheets((current) =>
        current.map((spreadsheet) => (spreadsheet.id === spreadsheetId ? data.spreadsheet : spreadsheet)),
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Extraction retry failed";
      setSpreadsheets((current) =>
        current.map((spreadsheet) =>
          spreadsheet.id === spreadsheetId ? { ...spreadsheet, error_message: message, status: "failed" } : spreadsheet,
        ),
      );
      setError(message);
    } finally {
      setRetryingId(null);
    }
  }

  async function deleteSpreadsheet(spreadsheet: Spreadsheet) {
    if (deletingId) return;
    if (!window.confirm(`Delete ${spreadsheet.filename}? This removes the uploaded file and extracted data.`)) return;

    setDeletingId(spreadsheet.id);
    setError(null);

    try {
      await fetchJson<{ ok: true }>(`/api/spreadsheets/${spreadsheet.id}`, {
        method: "DELETE",
      });
      setSpreadsheets((current) => current.filter((item) => item.id !== spreadsheet.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="content-band">
      <header className="section-header">
        <div>
          <p className="eyebrow">Data Library</p>
          <h1>Uploaded sheets</h1>
        </div>
        <Link to="/upload" className="primary-link">
          <Upload size={18} />
          <span>Upload</span>
        </Link>
      </header>

      <section className="library-summary">
        <article>
          <Layers3 size={18} />
          <span>Total sheets</span>
          <strong>{spreadsheets.length}</strong>
        </article>
        <article>
          <FileSpreadsheet size={18} />
          <span>Ready</span>
          <strong>{readyCount}</strong>
        </article>
        <article>
          <Database size={18} />
          <span>Pre-extracted</span>
          <strong>{preExtractedCount}</strong>
        </article>
        <article>
          <Trash2 size={18} />
          <span>Failed</span>
          <strong>{failedCount}</strong>
        </article>
      </section>

      <section className="library-controls">
        <label className="library-search">
          <Search size={18} />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search filename, category, type, status..." />
        </label>
        <Tabs
          tabs={[
            { label: "Category", value: "category" },
            { label: "Status", value: "status" },
            { label: "Extraction", value: "extraction" },
            { label: "Type", value: "type" },
          ]}
          value={groupMode}
          onValueChange={(value) => setGroupMode(value as LibraryGroupMode)}
        />
      </section>

      {isLoading ? (
        <div className="status-line">
          <Loader size="sm" />
          <span>Loading spreadsheets</span>
        </div>
      ) : error ? (
        <Banner variant="error" title="Could not load spreadsheets" description={error} />
      ) : spreadsheets.length === 0 ? (
        <Empty
          className="empty-list"
          icon={<FileSpreadsheet size={42} />}
          title="No library sheets yet"
          description="Upload a spreadsheet to add it to the Data Library."
          contents={
            <Link to="/upload" className="primary-link">
              <Upload size={18} />
              <span>Upload first spreadsheet</span>
            </Link>
          }
        />
      ) : filteredSpreadsheets.length === 0 ? (
        <Empty
          className="empty-list"
          icon={<Search size={42} />}
          title="No matching sheets"
          description="Adjust the search text or grouping filter."
        />
      ) : (
        <div className="category-groups">
          {groupedSpreadsheets.map((group) => (
            <section className="category-group" key={group.label}>
              <header>
                <h2>{group.label}</h2>
                <span>{group.items.length} sheets</span>
              </header>
              <div className="spreadsheet-list">
                {group.items.map((spreadsheet) => (
                  <Link
                    className={`spreadsheet-row ${spreadsheet.status === "failed" ? "failed" : ""}`}
                    key={spreadsheet.id}
                    params={{ spreadsheetId: spreadsheet.id }}
                    to="/spreadsheets/$spreadsheetId"
                  >
                    <FileSpreadsheet size={22} />
                    <div>
                      <h2>{spreadsheet.filename}</h2>
                      <p>
                        {formatBytes(spreadsheet.size_bytes)} · {contentTypeLabel(spreadsheet.content_type)} · {spreadsheet.agent_name}
                      </p>
                      <div className="row-badges">
                        <Badge variant="neutral">{spreadsheet.category || "Uncategorised"}</Badge>
                        <Badge appearance="dot" variant={statusVariant(spreadsheet.status)}>
                          {spreadsheet.status ?? "ready"}
                        </Badge>
                        <Badge variant={spreadsheet.pre_extract === 0 ? "neutral" : "teal-subtle"}>{extractionLabel(spreadsheet)}</Badge>
                        {spreadsheet.uploaded_at ? <Badge variant="neutral">{new Date(spreadsheet.uploaded_at).toLocaleDateString()}</Badge> : null}
                      </div>
                      {spreadsheet.error_message ? <p className="row-error">{spreadsheet.error_message}</p> : null}
                    </div>
                    <div className="row-actions">
                      <Button
                        aria-label={`View upload flow for ${spreadsheet.filename}`}
                        icon={<History size={16} />}
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void navigate({
                            params: { spreadsheetId: spreadsheet.id },
                            to: "/spreadsheets/$spreadsheetId/upload-flow",
                          });
                        }}
                      >
                        Flow
                      </Button>
                      {spreadsheet.status === "failed" ? (
                        <Button
                          className="retry-button"
                          disabled={retryingId === spreadsheet.id || deletingId === spreadsheet.id}
                          loading={retryingId === spreadsheet.id}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void retryExtraction(spreadsheet.id);
                          }}
                        >
                          <span>{retryingId === spreadsheet.id ? "Retrying" : "Retry extraction"}</span>
                        </Button>
                      ) : null}
                      <Button
                        aria-label={`Delete ${spreadsheet.filename}`}
                        className="delete-button"
                        disabled={deletingId === spreadsheet.id}
                        loading={deletingId === spreadsheet.id}
                        shape="square"
                        size="sm"
                        title="Delete spreadsheet"
                        type="button"
                        variant="secondary-destructive"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void deleteSpreadsheet(spreadsheet);
                        }}
                      >
                        <Trash2 size={16} />
                      </Button>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function UploadPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [category, setCategory] = useState("Uncategorised");
  const [preExtract, setPreExtract] = useState(true);
  const [uploadAgentName, setUploadAgentName] = useState<string | null>(null);
  const [uploadSpreadsheetId, setUploadSpreadsheetId] = useState<string | null>(null);
  const [uploadTraces, setUploadTraces] = useState<AgentTrace[]>([]);
  const [selectedUploadTraceId, setSelectedUploadTraceId] = useState<string | null>(null);
  useAgent({
    agent: "SheetsThink",
    enabled: Boolean(uploadAgentName),
    name: uploadAgentName ?? "upload-preview",
    onMessage: (event) => {
      if (typeof event.data !== "string") return;

      try {
        const message = JSON.parse(event.data) as unknown;
        if (!isAgentTraceMessage(message)) return;
        setUploadTraces((current) =>
          [...current.filter((trace) => trace.id !== message.trace.id), message.trace].sort(
            (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
          ),
        );
      } catch {
        return;
      }
    },
  });

  useEffect(() => {
    if (!uploadSpreadsheetId || !uploadAgentName) return;

    let isMounted = true;
    const pollTraces = async () => {
      try {
        const data = await fetchJson<AgentTraceResponse>(`/api/spreadsheets/${uploadSpreadsheetId}/traces`);
        if (!isMounted) return;
        setUploadTraces((current) => {
          const traces = new Map(current.map((trace) => [trace.id, trace]));
          for (const trace of data.traces) traces.set(trace.id, trace);
          return [...traces.values()].sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime());
        });
      } catch {
        // Websocket updates remain the primary path; polling is just a resilience net.
      }
    };

    void pollTraces();
    const interval = window.setInterval(() => void pollTraces(), 1200);
    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, [uploadAgentName, uploadSpreadsheetId]);

  useEffect(() => {
    if (uploadTraces.length === 0) {
      setSelectedUploadTraceId(null);
      return;
    }
    setSelectedUploadTraceId((current) => {
      if (current && uploadTraces.some((trace) => trace.id === current)) return current;
      return uploadTraces[uploadTraces.length - 1]?.id ?? null;
    });
  }, [uploadTraces]);

  function selectFile(nextFile: File | null) {
    setFile(nextFile);
    setError(null);
    setUploadTraces([]);
    setSelectedUploadTraceId(null);
    setUploadSpreadsheetId(null);
    setUploadAgentName(null);
  }

  function handleDragOver(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  }

  function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || isUploading) return;

    const spreadsheetId = crypto.randomUUID();
    const agentName = `spreadsheet-${spreadsheetId}`;
    const formData = new FormData();
    formData.append("spreadsheet", file);
    formData.append("spreadsheetId", spreadsheetId);
    formData.append("preExtract", String(preExtract));
    formData.append("category", category.trim() || "Uncategorised");
    setError(null);
    setIsUploading(true);
    setUploadAgentName(agentName);
    setUploadSpreadsheetId(spreadsheetId);
    setUploadTraces([
      {
        created_at: new Date().toISOString(),
        detail: JSON.stringify({ filename: file.name, preExtract, sizeBytes: file.size }),
        duration_ms: null,
        id: "client-upload-started",
        request_id: null,
        span_type: "upload",
        status: "running",
        step_number: null,
        title: "Preparing upload",
      },
    ]);

    try {
      const data = await fetchJson<SpreadsheetResponse>("/api/spreadsheets", {
        body: formData,
        method: "POST",
      });
      if (preExtract) {
        const completed = await waitForSpreadsheetExtraction(data.spreadsheet.id);
        if (completed.status === "failed") {
          throw new Error(completed.error_message ?? "Pre-extraction failed");
        }
      }
      await navigate({
        params: { spreadsheetId: data.spreadsheet.id },
        to: "/spreadsheets/$spreadsheetId",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      setIsUploading(false);
      setUploadAgentName(null);
    }
  }

  const hasUploadStarted = isUploading || uploadTraces.length > 0 || Boolean(uploadSpreadsheetId);
  const latestTrace = uploadTraces[uploadTraces.length - 1] ?? null;
  const selectedUploadTrace = uploadTraces.find((trace) => trace.id === selectedUploadTraceId) ?? latestTrace;
  const completedTraceCount = uploadTraces.filter((trace) => trace.status === "done").length;
  const runningTraceCount = uploadTraces.filter((trace) => trace.status === "running").length;
  const erroredTraceCount = uploadTraces.filter((trace) => trace.status === "error").length;
  const totalTraceDuration = uploadTraces.reduce((total, trace) => total + (trace.duration_ms ?? 0), 0);

  function downloadUploadTrace() {
    downloadJsonFile(`${safeDownloadName(file?.name ?? "spreadsheet")}-upload-trace.json`, {
      agentName: uploadAgentName,
      category: category.trim() || "Uncategorised",
      filename: file?.name ?? null,
      preExtract,
      spreadsheetId: uploadSpreadsheetId,
      traces: uploadTraces,
    });
  }

  return (
    <section className={`content-band upload-page ${hasUploadStarted ? "is-processing" : "narrow"}`}>
      <Link to="/" className="back-link">
        <ArrowLeft size={18} />
        <span>Spreadsheets</span>
      </Link>
      <header className="section-header">
        <div>
          <p className="eyebrow">Upload</p>
          <h1>Add a spreadsheet</h1>
        </div>
      </header>

      {!hasUploadStarted ? (
        <form className="upload-form" onSubmit={submitUpload}>
          <label
            className={`file-drop ${isDragging ? "is-dragging" : ""}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <Upload size={28} />
            <span>{file ? file.name : "Drop a spreadsheet here or choose .xlsx, .xls, .csv, .tsv, .ods, or .xml"}</span>
            <input
              accept=".xlsx,.xls,.csv,.tsv,.ods,.xml"
              type="file"
              onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
            />
          </label>

          <label className="form-field">
            <span>Category</span>
            <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Uncategorised" />
          </label>

          <label className="mode-toggle">
            <input
              checked={preExtract}
              disabled={isUploading}
              type="checkbox"
              onChange={(event) => setPreExtract(event.target.checked)}
            />
            <span />
            <strong>{preExtract ? "Pre-extract with codemode" : "Just upload"}</strong>
          </label>

          {error ? <Banner variant="error" title="Upload failed" description={error} /> : null}

          <Button
            className="primary-button"
            icon={<Upload size={18} />}
            loading={isUploading}
            type="submit"
            variant="primary"
            disabled={!file || isUploading}
          >
            <span>Create agent</span>
          </Button>
        </form>
      ) : (
        <section className="upload-processing">
          <div className="upload-processing-summary">
            <div>
              <p className="eyebrow">{preExtract ? "Codemode analysis" : "Upload"}</p>
              <h2>{file?.name ?? "Spreadsheet upload"}</h2>
              <p>
                {category.trim() || "Uncategorised"} · {preExtract ? "Pre-extracting into an agent SQLite database" : "Storing file"}
              </p>
            </div>
            <div className="upload-summary-actions">
              <div className="upload-progress-stats">
                <strong>{uploadTraces.length}</strong>
                <span>steps</span>
                <strong>{completedTraceCount}</strong>
                <span>done</span>
                <strong>{runningTraceCount}</strong>
                <span>running</span>
              </div>
              <Button
                disabled={uploadTraces.length === 0}
                icon={<Download size={16} />}
                size="sm"
                type="button"
                variant="secondary"
                onClick={downloadUploadTrace}
              >
                Download trace
              </Button>
            </div>
          </div>

          {error ? <Banner variant="error" title="Upload failed" description={error} /> : null}

          <div className="upload-trace-workbench">
            <section className="upload-trace-list" aria-label="Upload and analysis events">
              <header>
                <div>
                  <p className="eyebrow">{preExtract ? "Live analysis trace" : "Live upload trace"}</p>
                  <h2>{latestTrace?.title ?? (preExtract ? "Preparing spreadsheet agent" : "Storing spreadsheet file")}</h2>
                </div>
                <div className="trace-metrics" aria-label="Trace summary">
                  <span><strong>{uploadTraces.length}</strong> events</span>
                  <span><strong>{completedTraceCount}</strong> done</span>
                  <span><strong>{runningTraceCount}</strong> running</span>
                  {erroredTraceCount > 0 ? <span className="error"><strong>{erroredTraceCount}</strong> errors</span> : null}
                  <span><strong>{formatDuration(totalTraceDuration)}</strong> captured</span>
                </div>
              </header>

              <div className="upload-trace-table-wrap">
                <table className="upload-trace-table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Status</th>
                      <th>Event</th>
                      <th>Started</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {uploadTraces.map((trace) => {
                      const isSelected = selectedUploadTrace?.id === trace.id;
                      const summary = traceSummary(trace.detail);
                      return (
                        <tr
                          aria-selected={isSelected}
                          className={`${trace.status} ${isSelected ? "is-selected" : ""}`}
                          key={trace.id}
                          onClick={() => setSelectedUploadTraceId(trace.id)}
                        >
                          <td>
                            <span className="trace-step-index">{trace.step_number ?? "—"}</span>
                            <span>{trace.span_type}</span>
                          </td>
                          <td>
                            <span className={`trace-status-pill ${trace.status}`}>
                              <span className="trace-dot" />
                              {trace.status}
                            </span>
                          </td>
                          <td>
                            <strong>{trace.title}</strong>
                            {summary ? <small>{summary}</small> : null}
                          </td>
                          <td>{formatTraceTime(trace.created_at)}</td>
                          <td>{formatDuration(trace.duration_ms)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <aside className="upload-trace-detail">
              {selectedUploadTrace ? (
                <>
                  <header>
                    <div>
                      <p className="eyebrow">Selected event</p>
                      <h2>{selectedUploadTrace.title}</h2>
                    </div>
                    <span className={`trace-status-pill ${selectedUploadTrace.status}`}>
                      <span className="trace-dot" />
                      {selectedUploadTrace.status}
                    </span>
                  </header>
                  <dl className="trace-detail-grid">
                    {traceKeyValues(selectedUploadTrace).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <TracePayloadView trace={selectedUploadTrace} />
                </>
              ) : (
                <Empty
                  className="viewer-empty"
                  icon={<Clock size={32} />}
                  size="sm"
                  title="Waiting for trace events"
                  description="Events will appear here as the upload starts."
                />
              )}
            </aside>
          </div>
        </section>
      )}
    </section>
  );
}

function SpreadsheetUploadFlowPage() {
  const { spreadsheetId } = useParams({ from: "/spreadsheets/$spreadsheetId/upload-flow" });
  const [spreadsheet, setSpreadsheet] = useState<Spreadsheet | null>(null);
  const [traces, setTraces] = useState<AgentTrace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function loadFlow() {
      try {
        const [spreadsheetData, traceData] = await Promise.all([
          fetchJson<SpreadsheetResponse>(`/api/spreadsheets/${spreadsheetId}`),
          fetchJson<AgentTraceResponse>(`/api/spreadsheets/${spreadsheetId}/extraction-trace`),
        ]);
        if (!isMounted) return;
        setSpreadsheet(spreadsheetData.spreadsheet);
        setTraces(traceData.traces);
        setError(null);
      } catch (caught) {
        if (isMounted) setError(caught instanceof Error ? caught.message : "Could not load upload flow");
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }

    void loadFlow();
    const interval = window.setInterval(() => {
      if (spreadsheet?.status === "processing") void loadFlow();
    }, 1500);
    return () => {
      isMounted = false;
      window.clearInterval(interval);
    };
  }, [spreadsheetId, spreadsheet?.status]);

  useEffect(() => {
    if (traces.length === 0) {
      setSelectedTraceId(null);
      return;
    }
    setSelectedTraceId((current) => {
      if (current && traces.some((trace) => trace.id === current)) return current;
      return traces[traces.length - 1]?.id ?? null;
    });
  }, [traces]);

  const selectedTrace = traces.find((trace) => trace.id === selectedTraceId) ?? traces[traces.length - 1] ?? null;
  const completedTraceCount = traces.filter((trace) => trace.status === "done").length;
  const runningTraceCount = traces.filter((trace) => trace.status === "running").length;
  const erroredTraceCount = traces.filter((trace) => trace.status === "error").length;
  const totalTraceDuration = traces.reduce((total, trace) => total + (trace.duration_ms ?? 0), 0);

  function downloadFlowTrace() {
    downloadJsonFile(`${safeDownloadName(spreadsheet?.filename ?? "spreadsheet")}-upload-flow.json`, {
      agentName: spreadsheet?.agent_name ?? null,
      category: spreadsheet?.category ?? null,
      filename: spreadsheet?.filename ?? null,
      preExtract: spreadsheet?.pre_extract !== 0,
      spreadsheetId,
      traces,
    });
  }

  return (
    <section className="content-band upload-page is-processing">
      <Link to={spreadsheet ? "/spreadsheets/$spreadsheetId" : "/"} params={spreadsheet ? { spreadsheetId } : undefined} className="back-link">
        <ArrowLeft size={18} />
        <span>{spreadsheet ? "Spreadsheet" : "Spreadsheets"}</span>
      </Link>

      {isLoading ? (
        <div className="status-line">
          <Loader size="sm" />
          <span>Loading upload flow</span>
        </div>
      ) : error ? (
        <Banner variant="error" title="Could not load upload flow" description={error} />
      ) : (
        <section className="upload-processing">
          <div className="upload-processing-summary">
            <div>
              <p className="eyebrow">Upload and extraction flow</p>
              <h2>{spreadsheet?.filename ?? "Spreadsheet"}</h2>
              <p>
                {spreadsheet?.category || "Uncategorised"} · {spreadsheet ? extractionLabel(spreadsheet) : "Trace"} · {spreadsheet?.status ?? "ready"}
              </p>
            </div>
            <div className="upload-summary-actions">
              <div className="upload-progress-stats">
                <strong>{traces.length}</strong>
                <span>steps</span>
                <strong>{completedTraceCount}</strong>
                <span>done</span>
                <strong>{runningTraceCount}</strong>
                <span>running</span>
              </div>
              <Button
                disabled={traces.length === 0}
                icon={<Download size={16} />}
                size="sm"
                type="button"
                variant="secondary"
                onClick={downloadFlowTrace}
              >
                Download trace
              </Button>
            </div>
          </div>

          <div className="upload-trace-workbench">
            <section className="upload-trace-list" aria-label="Upload and analysis events">
              <header>
                <div>
                  <p className="eyebrow">Saved trace</p>
                  <h2>{selectedTrace?.title ?? "No trace events yet"}</h2>
                </div>
                <div className="trace-metrics" aria-label="Trace summary">
                  <span><strong>{traces.length}</strong> events</span>
                  <span><strong>{completedTraceCount}</strong> done</span>
                  <span><strong>{runningTraceCount}</strong> running</span>
                  {erroredTraceCount > 0 ? <span className="error"><strong>{erroredTraceCount}</strong> errors</span> : null}
                  <span><strong>{formatDuration(totalTraceDuration)}</strong> captured</span>
                </div>
              </header>

              <div className="upload-trace-table-wrap">
                <table className="upload-trace-table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>Status</th>
                      <th>Event</th>
                      <th>Started</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traces.map((trace) => {
                      const isSelected = selectedTrace?.id === trace.id;
                      const summary = traceSummary(trace.detail);
                      return (
                        <tr
                          aria-selected={isSelected}
                          className={`${trace.status} ${isSelected ? "is-selected" : ""}`}
                          key={trace.id}
                          onClick={() => setSelectedTraceId(trace.id)}
                        >
                          <td>
                            <span className="trace-step-index">{trace.step_number ?? "-"}</span>
                            <span>{trace.span_type}</span>
                          </td>
                          <td>
                            <span className={`trace-status-pill ${trace.status}`}>
                              <span className="trace-dot" />
                              {trace.status}
                            </span>
                          </td>
                          <td>
                            <strong>{trace.title}</strong>
                            {summary ? <small>{summary}</small> : null}
                          </td>
                          <td>{formatTraceTime(trace.created_at)}</td>
                          <td>{formatDuration(trace.duration_ms)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <aside className="upload-trace-detail">
              {selectedTrace ? (
                <>
                  <header>
                    <div>
                      <p className="eyebrow">Selected event</p>
                      <h2>{selectedTrace.title}</h2>
                    </div>
                    <span className={`trace-status-pill ${selectedTrace.status}`}>
                      <span className="trace-dot" />
                      {selectedTrace.status}
                    </span>
                  </header>
                  <dl className="trace-detail-grid">
                    {traceKeyValues(selectedTrace).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <TracePayloadView trace={selectedTrace} />
                </>
              ) : (
                <Empty
                  className="viewer-empty"
                  icon={<Clock size={32} />}
                  size="sm"
                  title="No upload flow captured"
                  description="This sheet does not have saved upload or extraction events yet."
                />
              )}
            </aside>
          </div>
        </section>
      )}
    </section>
  );
}

function SpreadsheetChatPage() {
  const { spreadsheetId } = useParams({ from: "/spreadsheets/$spreadsheetId" });
  const [spreadsheet, setSpreadsheet] = useState<Spreadsheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    setSpreadsheet(null);
    setError(null);
    fetchJson<SpreadsheetResponse>(`/api/spreadsheets/${spreadsheetId}`)
      .then((data) => setSpreadsheet(data.spreadsheet))
      .catch((caught: Error) => setError(caught.message));
  }, [spreadsheetId]);

  if (error) {
    return (
      <section className="content-band">
        <Link to="/" className="back-link">
          <ArrowLeft size={18} />
          <span>Spreadsheets</span>
        </Link>
        <Banner variant="error" title="Could not load spreadsheet" description={error} />
      </section>
    );
  }

  if (!spreadsheet) {
    return (
      <section className="content-band">
        <div className="status-line">
          <Loader size="sm" />
          <span>Loading spreadsheet agent</span>
        </div>
      </section>
    );
  }

  return <ChatSurface input={input} setInput={setInput} setSpreadsheet={setSpreadsheet} spreadsheet={spreadsheet} />;
}

function ChatSurface({
  input,
  setInput,
  setSpreadsheet,
  spreadsheet,
}: {
  input: string;
  setInput: (value: string) => void;
  setSpreadsheet: (spreadsheet: Spreadsheet) => void;
  spreadsheet: Spreadsheet;
}) {
  const [traces, setTraces] = useState<AgentTrace[]>([]);
  const agent = useAgent({
    agent: "SheetsThink",
    name: spreadsheet.agent_name,
    onMessage: (event) => {
      if (typeof event.data !== "string") return;

      try {
        const message = JSON.parse(event.data) as unknown;
        if (!isAgentTraceMessage(message)) return;
        setTraces((current) => [...current.filter((trace) => trace.id !== message.trace.id), message.trace].slice(-30));
      } catch {
        return;
      }
    },
  });
  const [isSending, setIsSending] = useState(false);
  const isBusy = isSending;
  const [isTraceCollapsed, setIsTraceCollapsed] = useState(false);
  const [activeView, setActiveView] = useState<AgentView>("chat");
  const [analysisTables, setAnalysisTables] = useState<AnalysisTablesResponse | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<AnalysisTableResponse | null>(null);
  const [rawPreview, setRawPreview] = useState<RawPreviewResponse | null>(null);
  const [revisions, setRevisions] = useState<SpreadsheetRevision[] | null>(null);
  const [revisionFile, setRevisionFile] = useState<File | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [isViewerLoading, setIsViewerLoading] = useState(false);
  const [isRetryingExtraction, setIsRetryingExtraction] = useState(false);
  const [isUploadingRevision, setIsUploadingRevision] = useState(false);
  const [renderedMessages, setRenderedMessages] = useState<RenderedMessage[]>([]);
  const [latestChatRun, setLatestChatRun] = useState<BenchmarkRun | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let isMounted = true;
    fetchJson<AgentChatHistoryResponse>(`/api/spreadsheets/${spreadsheet.id}/chat-history`)
      .then((data) => {
        if (!isMounted) return;
        setRenderedMessages(data.messages.map((message) => ({ id: message.id, role: message.role, text: message.text })));
      })
      .catch(() => undefined);
    return () => {
      isMounted = false;
    };
  }, [spreadsheet.id]);

  useEffect(() => {
    if (activeView !== "chat") return;
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeView, isBusy, latestChatRun, renderedMessages.length, showEvidence]);

  useEffect(() => {
    let isMounted = true;

    fetchJson<AgentTraceResponse>(`/api/spreadsheets/${spreadsheet.id}/traces`)
      .then((data) => {
        if (isMounted) setTraces(data.traces);
      })
      .catch(() => {
        if (isMounted) setTraces([]);
      });

    return () => {
      isMounted = false;
    };
  }, [spreadsheet.id]);

  useEffect(() => {
    if (activeView !== "sqlite" || analysisTables) return;

    let isMounted = true;
    setIsViewerLoading(true);
    setViewerError(null);

    fetchJson<AnalysisTablesResponse>(`/api/spreadsheets/${spreadsheet.id}/tables`)
      .then((data) => {
        if (!isMounted) return;
        setAnalysisTables(data);
        setSelectedTable(data.tables[0]?.table_name ?? null);
      })
      .catch((caught: Error) => {
        if (isMounted) setViewerError(caught.message);
      })
      .finally(() => {
        if (isMounted) setIsViewerLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeView, analysisTables, spreadsheet.id]);

  useEffect(() => {
    if (activeView !== "sqlite" || !selectedTable) return;

    let isMounted = true;
    setIsViewerLoading(true);
    setViewerError(null);

    fetchJson<AnalysisTableResponse>(`/api/spreadsheets/${spreadsheet.id}/tables/${encodeURIComponent(selectedTable)}`)
      .then((data) => {
        if (isMounted) setTableData(data);
      })
      .catch((caught: Error) => {
        if (isMounted) setViewerError(caught.message);
      })
      .finally(() => {
        if (isMounted) setIsViewerLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeView, selectedTable, spreadsheet.id]);

  useEffect(() => {
    if (activeView !== "raw" || rawPreview) return;

    let isMounted = true;
    setIsViewerLoading(true);
    setViewerError(null);

    fetchJson<RawPreviewResponse>(`/api/spreadsheets/${spreadsheet.id}/raw-preview`)
      .then((data) => {
        if (isMounted) setRawPreview(data);
      })
      .catch((caught: Error) => {
        if (isMounted) setViewerError(caught.message);
      })
      .finally(() => {
        if (isMounted) setIsViewerLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeView, rawPreview, spreadsheet.id]);

  useEffect(() => {
    if (activeView !== "revisions" || revisions) return;

    let isMounted = true;
    setIsViewerLoading(true);
    setViewerError(null);

    fetchJson<SpreadsheetRevisionsResponse>(`/api/spreadsheets/${spreadsheet.id}/revisions`)
      .then((data) => {
        if (!isMounted) return;
        setRevisions(data.revisions);
        setSpreadsheet(data.spreadsheet);
      })
      .catch((caught: Error) => {
        if (isMounted) setViewerError(caught.message);
      })
      .finally(() => {
        if (isMounted) setIsViewerLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeView, revisions, setSpreadsheet, spreadsheet.id]);

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;

    const totalStarted = performance.now();
    const userMessage: RenderedMessage = { id: crypto.randomUUID(), role: "user", text };
    const thinkingId = crypto.randomUUID();
    setRenderedMessages((current) => [...current, userMessage, { id: thinkingId, role: "assistant", text: "Thinking..." }]);
    setInput("");
    setIsSending(true);
    setShowEvidence(false);

    try {
      const answerStarted = performance.now();
      const answer = await fetchJson<AgentRequestResponse>(`/api/spreadsheets/${spreadsheet.id}/agent-request`, {
        body: JSON.stringify({ message: text }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const run = createBenchmarkRunFromAnswer({
        answer,
        answerSeconds: (performance.now() - answerStarted) / 1000,
        prompt: text,
        spreadsheetFilename: spreadsheet.filename,
        spreadsheetId: spreadsheet.id,
        totalSeconds: (performance.now() - totalStarted) / 1000,
        uploadSeconds: null,
      });
      setLatestChatRun(run);
      setRenderedMessages((current) =>
        current.map((message) =>
          message.id === thinkingId ? { benchmarkRun: run, id: answer.requestId, role: "assistant", text: answer.response } : message,
        ),
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Agent request failed";
      setRenderedMessages((current) =>
        current.map((item) => (item.id === thinkingId ? { id: thinkingId, role: "assistant", text: message } : item)),
      );
    } finally {
      setIsSending(false);
    }
  }

  async function addMessageToBenchmark(messageId: string) {
    const message = renderedMessages.find((item) => item.id === messageId);
    if (!message?.benchmarkRun || message.benchmarkSaved || message.benchmarkSaving) return;

    setRenderedMessages((current) => current.map((item) => (item.id === messageId ? { ...item, benchmarkSaving: true } : item)));
    try {
      const savedRun = await saveBenchmarkRun(message.benchmarkRun);
      setLatestChatRun(savedRun);
      setRenderedMessages((current) =>
        current.map((item) =>
          item.id === messageId ? { ...item, benchmarkRun: savedRun, benchmarkSaved: true, benchmarkSaving: false } : item,
        ),
      );
    } catch (caught) {
      setViewerError(caught instanceof Error ? caught.message : "Could not add benchmark run");
      setRenderedMessages((current) => current.map((item) => (item.id === messageId ? { ...item, benchmarkSaving: false } : item)));
    }
  }

  async function clearChat() {
    if (isBusy) return;
    setRenderedMessages([]);
    setLatestChatRun(null);
    setShowEvidence(false);
    setInput("");
    await fetch(`/api/spreadsheets/${spreadsheet.id}/chat-history`, { method: "DELETE" }).catch(() => undefined);
  }

  async function retryExtraction() {
    if (isRetryingExtraction) return;
    setIsRetryingExtraction(true);
    setViewerError(null);
    setSpreadsheet({ ...spreadsheet, error_message: null, pre_extract: 1, status: "processing" });

    try {
      const data = await fetchJson<SpreadsheetResponse>(`/api/spreadsheets/${spreadsheet.id}/retry-extraction`, {
        method: "POST",
      });
      setAnalysisTables(null);
      setSelectedTable(null);
      setTableData(null);
      setSpreadsheet(data.spreadsheet);
      setActiveView("sqlite");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Extraction retry failed";
      setViewerError(message);
      setSpreadsheet({ ...spreadsheet, error_message: message, status: "failed" });
    } finally {
      setIsRetryingExtraction(false);
    }
  }

  async function uploadRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!revisionFile || isUploadingRevision) return;

    setIsUploadingRevision(true);
    setViewerError(null);

    const formData = new FormData();
    formData.append("spreadsheet", revisionFile);
    formData.append("preExtract", spreadsheet.pre_extract === 0 ? "false" : "true");

    try {
      const data = await fetchJson<SpreadsheetRevisionUploadResponse>(`/api/spreadsheets/${spreadsheet.id}/revisions`, {
        body: formData,
        method: "POST",
      });
      if (data.spreadsheet) setSpreadsheet(data.spreadsheet);
      if (data.revision) setRevisions((current) => [data.revision!, ...(current ?? [])]);
      setAnalysisTables(null);
      setSelectedTable(null);
      setTableData(null);
      setRawPreview(null);
      setRevisionFile(null);
      setActiveView("revisions");
    } catch (caught) {
      setViewerError(caught instanceof Error ? caught.message : "Revision upload failed");
    } finally {
      setIsUploadingRevision(false);
    }
  }

  async function downloadExtractionTrace() {
    const data = await fetchJson<AgentTraceResponse>(`/api/spreadsheets/${spreadsheet.id}/extraction-trace`);
    downloadJsonFile(`${safeDownloadName(spreadsheet.filename)}-extraction-trace.json`, {
      agentName: spreadsheet.agent_name,
      filename: spreadsheet.filename,
      spreadsheetId: spreadsheet.id,
      traces: data.traces,
    });
  }

  function downloadOriginalFile() {
    window.location.href = `/api/spreadsheets/${spreadsheet.id}/file`;
  }

  const showChatChrome = activeView === "chat";

  return (
    <section className="chat-page">
      <header className="chat-header">
        <Link to="/" className="back-link">
          <ArrowLeft size={18} />
          <span>Spreadsheets</span>
        </Link>
        <div>
          <p className="eyebrow">{spreadsheet.agent_name}</p>
          <h1>{spreadsheet.filename}</h1>
          <p className="muted">
            {formatBytes(spreadsheet.size_bytes)} · {spreadsheet.content_type || "spreadsheet"} · {extractionLabel(spreadsheet)}
          </p>
        </div>
        {spreadsheet.status === "failed" ? (
          <Button
            className="retry-button header-retry"
            disabled={isRetryingExtraction}
            loading={isRetryingExtraction}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => void retryExtraction()}
          >
            <span>{isRetryingExtraction ? "Retrying extraction" : "Retry extraction"}</span>
          </Button>
        ) : null}
      </header>

      <div className="chat-stickybar">
        <div className="chat-sticky-title">
          <FileSpreadsheet size={18} />
          <span>{spreadsheet.filename}</span>
          <small>{extractionLabel(spreadsheet)}</small>
        </div>
        <div className="chat-toolbar">
          <Link
            className="nav-button"
            params={{ spreadsheetId: spreadsheet.id }}
            to="/spreadsheets/$spreadsheetId/upload-flow"
          >
            <History size={16} />
            <span>Flow</span>
          </Link>
          <Tabs
            className="view-tabs"
            size="sm"
            value={activeView}
            variant="segmented"
            tabs={[
              { label: <span className="tab-label"><FileSpreadsheet size={16} /> Chat</span>, value: "chat" },
              { label: <span className="tab-label"><Database size={16} /> SQLite</span>, value: "sqlite" },
              { label: <span className="tab-label"><FileText size={16} /> Raw</span>, value: "raw" },
              { label: <span className="tab-label"><History size={16} /> Revisions</span>, value: "revisions" },
            ]}
            onValueChange={(value) => setActiveView(value as AgentView)}
          />
          <Button
            icon={<Download size={16} />}
            size="sm"
            type="button"
            variant="secondary"
            onClick={downloadOriginalFile}
          >
            Original file
          </Button>
          {activeView === "chat" ? (
            <>
              <Button
                disabled={!latestChatRun}
                icon={<Search size={16} />}
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => setShowEvidence((value) => !value)}
              >
                {showEvidence ? "Hide evidence" : "Evidence"}
              </Button>
            <Button
              disabled={isBusy || renderedMessages.length === 0}
              icon={<Trash2 size={16} />}
              size="sm"
              type="button"
              variant="secondary-destructive"
              onClick={clearChat}
            >
              Clear chat
            </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className={`chat-main ${showChatChrome ? "" : "inspect-mode"} ${isTraceCollapsed ? "trace-collapsed" : ""}`}>
        <div className="chat-workspace">
          {activeView === "chat" ? (
            <div className="messages">
              {renderedMessages.length === 0 ? (
                <Empty
                  className="empty-state"
                  icon={<FileSpreadsheet size={38} />}
                  size="sm"
                  title="Spreadsheet agent ready"
                  description={
                    spreadsheet.pre_extract === 0
                      ? "This spreadsheet is available as a raw file in the sandbox."
                      : "This spreadsheet has a pre-extracted SQLite database."
                  }
                />
              ) : (
                renderedMessages.map((message, index) => (
                  <ChatMessage
                    key={message.id}
                    isStreaming={isBusy && message.role === "assistant" && index === renderedMessages.length - 1}
                    message={message}
                    onAddToBenchmark={addMessageToBenchmark}
                  />
                ))
              )}
              {showEvidence && latestChatRun ? <EvidenceViewer run={latestChatRun} /> : null}
              <div ref={messagesEndRef} />
            </div>
          ) : activeView === "sqlite" ? (
            <SQLiteViewer
              analysisTables={analysisTables}
              error={viewerError}
              isLoading={isViewerLoading}
              selectedTable={selectedTable}
              setSelectedTable={setSelectedTable}
              tableData={tableData}
            />
          ) : activeView === "raw" ? (
            <RawDocumentViewer error={viewerError} isLoading={isViewerLoading} rawPreview={rawPreview} />
          ) : (
            <RevisionViewer
              error={viewerError}
              isLoading={isViewerLoading}
              isUploading={isUploadingRevision}
              revisionFile={revisionFile}
              revisions={revisions}
              setRevisionFile={setRevisionFile}
              uploadRevision={uploadRevision}
            />
          )}

          {showChatChrome ? (
            <form className="composer" onSubmit={submitMessage}>
              <Input
                aria-label="Message"
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
              <VoiceInputButton disabled={isBusy} value={input} onTranscript={setInput} />
              <Button
                aria-label="Send message"
                className="icon-button"
                loading={isBusy}
                shape="square"
                type="submit"
                variant="primary"
                disabled={isBusy || !input.trim()}
              >
                <Send size={18} />
              </Button>
            </form>
          ) : null}
        </div>

        {showChatChrome ? (
          <aside className={`trace-panel ${isTraceCollapsed ? "is-collapsed" : ""}`}>
            <header>
              <div className="trace-heading">
                <p className="eyebrow">Trace</p>
                <h2>Agent steps</h2>
              </div>
              <div className="trace-actions">
                <Button
                  aria-label="Download extraction trace"
                  className="trace-toggle"
                  shape="square"
                  size="sm"
                  onClick={() => void downloadExtractionTrace()}
                  title="Download extraction trace"
                  type="button"
                  variant="secondary"
                >
                  <Download size={18} />
                </Button>
                <Button
                  aria-label={isTraceCollapsed ? "Expand trace panel" : "Collapse trace panel"}
                  className="trace-toggle"
                  shape="square"
                  size="sm"
                  onClick={() => setIsTraceCollapsed((value) => !value)}
                  title={isTraceCollapsed ? "Expand trace panel" : "Collapse trace panel"}
                  type="button"
                  variant="secondary"
                >
                  {isTraceCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
                </Button>
              </div>
            </header>
            <div className="trace-content" hidden={isTraceCollapsed}>
              {traces.length === 0 ? (
                <p className="trace-empty">No agent steps yet.</p>
              ) : (
                <ol className="trace-list">
                  {traces.map((trace) => {
                    const detail = formatTraceDetail(trace.detail);
                    return (
                      <li className={`trace-item ${trace.status}`} key={trace.id}>
                        <div>
                          <span className="trace-dot" />
                        </div>
                        <article>
                          <div className="trace-title-row">
                            <h3>{trace.title}</h3>
                            {trace.duration_ms ? <span>{trace.duration_ms}ms</span> : null}
                          </div>
                          <p>
                            {trace.span_type}
                            {trace.step_number !== null ? ` · step ${trace.step_number}` : ""}
                          </p>
                          {detail ? <pre>{detail}</pre> : null}
                        </article>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function SQLiteViewer({
  analysisTables,
  error,
  isLoading,
  selectedTable,
  setSelectedTable,
  tableData,
}: {
  analysisTables: AnalysisTablesResponse | null;
  error: string | null;
  isLoading: boolean;
  selectedTable: string | null;
  setSelectedTable: (tableName: string) => void;
  tableData: AnalysisTableResponse | null;
}) {
  return (
    <section className="data-viewer">
      <header className="viewer-header">
        <div>
          <p className="eyebrow">Extracted SQLite</p>
          <h2>{analysisTables?.analysis?.description ?? "Analysis database"}</h2>
        </div>
        {analysisTables?.analysis ? <span className="score-pill">{analysisTables.analysis.extraction_score}/100</span> : null}
      </header>

      {error ? <p className="viewer-error">{error}</p> : null}
      {isLoading && !tableData ? (
        <div className="viewer-loading">
          <Loader size="sm" />
          <span>Loading extracted tables</span>
        </div>
      ) : null}

      {analysisTables && analysisTables.tables.length === 0 ? (
        <Empty
          className="viewer-empty"
          icon={<Database size={32} />}
          size="sm"
          title="No extracted tables"
          description="No extracted SQLite tables were found for this spreadsheet."
        />
      ) : null}

      {analysisTables?.metadata ? <MetadataPanel metadata={analysisTables.metadata} /> : null}

      {analysisTables && analysisTables.tables.length > 0 ? (
        <div className="viewer-grid">
          <aside className="table-picker">
            {analysisTables.tables.map((table) => (
              <Button
                className={selectedTable === table.table_name ? "active" : ""}
                key={table.table_name}
                size="sm"
                type="button"
                variant={selectedTable === table.table_name ? "primary" : "secondary"}
                onClick={() => setSelectedTable(table.table_name)}
              >
                <Table2 size={16} />
                <span>{table.table_name}</span>
                <small>{table.row_count} rows</small>
              </Button>
            ))}
          </aside>

          <DataTable columns={tableData?.columns ?? []} rows={tableData?.rows ?? []} />
        </div>
      ) : null}
    </section>
  );
}

function MetadataPanel({ metadata }: { metadata: Record<string, unknown> }) {
  const summaryEntries = ([
    ["Category", metadata.category],
    ["Domain", metadata.domain],
    ["Period", metadata.time_period],
    ["Geography", metadata.geography],
  ] satisfies Array<[string, unknown]>).filter(([, value]) => hasMetadataValue(value));
  const entries = ([
    ["Title", metadata.title],
    ["Description", metadata.description],
    ["Category", metadata.category],
    ["Domain", metadata.domain],
    ["Geography", metadata.geography],
    ["Time period", metadata.time_period],
    ["Units", metadata.units],
    ["Source summary", metadata.source_summary],
    ["Caveats", metadata.caveats],
    ["Extraction notes", metadata.extraction_notes],
    ["Measures", parseMaybeJson(metadata.measures_json)],
    ["Dimensions", parseMaybeJson(metadata.dimensions_json)],
    ["Updated", metadata.updated_at],
  ] satisfies Array<[string, unknown]>).filter(([, value]) => hasMetadataValue(value));

  if (entries.length === 0) return null;

  return (
    <details className="metadata-panel">
      <summary>
        <div className="metadata-summary-main">
          <div>
            <p className="eyebrow">Metadata</p>
            <h2>{String(metadata.title || metadata.description || "Document metadata")}</h2>
          </div>
          {summaryEntries.length > 0 ? (
            <dl className="metadata-summary-list">
              {summaryEntries.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{metadataText(value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
        <div className="metadata-summary-actions">
          {hasMetadataValue(metadata.confidence_score) ? <span className="score-pill">{String(metadata.confidence_score)}/100</span> : null}
          <span className="metadata-toggle-label">Details</span>
        </div>
      </summary>
      <dl className="metadata-detail-list">
        {entries.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{metadataText(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function hasMetadataValue(value: unknown) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0 && value !== "{}" && value !== "[]";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function metadataText(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

function RawDocumentViewer({
  error,
  isLoading,
  rawPreview,
}: {
  error: string | null;
  isLoading: boolean;
  rawPreview: RawPreviewResponse | null;
}) {
  const [activeSheet, setActiveSheet] = useState(0);
  const sheet = rawPreview?.preview.sheets[activeSheet] ?? rawPreview?.preview.sheets[0] ?? null;

  useEffect(() => {
    setActiveSheet(0);
  }, [rawPreview?.filename]);

  return (
    <section className="data-viewer">
      <header className="viewer-header">
        <div>
          <p className="eyebrow">Raw document</p>
          <h2>{rawPreview?.filename ?? "Spreadsheet preview"}</h2>
          {rawPreview ? (
            <p className="muted">
              {rawPreview.preview.format} · {formatBytes(rawPreview.sizeBytes)}
            </p>
          ) : null}
        </div>
      </header>

      {error ? <p className="viewer-error">{error}</p> : null}
      {isLoading && !rawPreview ? (
        <div className="viewer-loading">
          <Loader size="sm" />
          <span>Loading raw preview</span>
        </div>
      ) : null}

      {rawPreview && rawPreview.preview.sheets.length > 1 ? (
        <Tabs
          className="sheet-tabs"
          size="sm"
          value={String(activeSheet)}
          variant="segmented"
          tabs={rawPreview.preview.sheets.map((nextSheet, index) => ({
            label: nextSheet.name,
            value: String(index),
          }))}
          onValueChange={(value) => setActiveSheet(Number(value))}
        />
      ) : null}

      {rawPreview && !sheet ? (
        <Empty
          className="viewer-empty"
          icon={<FileText size={32} />}
          size="sm"
          title="No previewable rows"
          description="No previewable rows were found in the raw spreadsheet."
        />
      ) : null}

      {sheet ? (
        <DataTable
          columns={Array.from({ length: sheet.columns }, (_, index) => `Column ${index + 1}`)}
          rows={sheet.rows.map((row) =>
            Object.fromEntries(Array.from({ length: sheet.columns }, (_, index) => [`Column ${index + 1}`, row[index] ?? ""])),
          )}
        />
      ) : null}
    </section>
  );
}

function RevisionViewer({
  error,
  isLoading,
  isUploading,
  revisionFile,
  revisions,
  setRevisionFile,
  uploadRevision,
}: {
  error: string | null;
  isLoading: boolean;
  isUploading: boolean;
  revisionFile: File | null;
  revisions: SpreadsheetRevision[] | null;
  setRevisionFile: (file: File | null) => void;
  uploadRevision: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="data-viewer revisions-viewer">
      <header className="viewer-header">
        <div>
          <p className="eyebrow">Revision history</p>
          <h2>{revisions ? `${revisions.length} stored version${revisions.length === 1 ? "" : "s"}` : "Stored versions"}</h2>
        </div>
        <form className="revision-upload" onSubmit={uploadRevision}>
          <label className="revision-file-input">
            <Upload size={16} />
            <span>{revisionFile ? revisionFile.name : "Select file"}</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv,.tsv,.ods,.xml"
              onChange={(event) => setRevisionFile(event.currentTarget.files?.[0] ?? null)}
            />
          </label>
          <Button disabled={!revisionFile || isUploading} loading={isUploading} size="sm" type="submit" variant="primary">
            <Upload size={16} />
            <span>Upload revision</span>
          </Button>
        </form>
      </header>

      {error ? <p className="viewer-error">{error}</p> : null}
      {isLoading && !revisions ? (
        <div className="viewer-loading">
          <Loader size="sm" />
          <span>Loading revisions</span>
        </div>
      ) : null}

      {revisions && revisions.length === 0 ? (
        <Empty
          className="viewer-empty"
          icon={<History size={32} />}
          size="sm"
          title="No revisions yet"
          description="Upload a revised spreadsheet to start the history."
        />
      ) : null}

      {revisions && revisions.length > 0 ? (
        <ol className="revision-list">
          {revisions.map((revision) => (
            <li className="revision-item" key={revision.id}>
              <div className="revision-number">
                <span>v{revision.revision_number}</span>
              </div>
              <article>
                <div className="revision-title-row">
                  <h3>{revision.filename}</h3>
                  <Badge variant={revision.action === "upload" ? "success" : "neutral"}>
                    {revision.action === "upload" ? "Initial upload" : "Revision"}
                  </Badge>
                </div>
                <p>{revision.summary ?? "Spreadsheet revision stored."}</p>
                <dl className="revision-meta">
                  <div>
                    <dt>Created</dt>
                    <dd>{formatDateTime(revision.created_at)}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{formatBytes(revision.size_bytes)}</dd>
                  </div>
                  <div>
                    <dt>Type</dt>
                    <dd>{contentTypeLabel(revision.content_type)}</dd>
                  </div>
                </dl>
              </article>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function DataTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  if (columns.length === 0 || rows.length === 0) {
    return (
      <Empty className="viewer-empty" icon={<Table2 size={32} />} size="sm" title="No rows to preview" />
    );
  }

  return (
    <div className="data-table-wrap">
      <Table className="data-table">
        <Table.Header>
          <Table.Row>
            {columns.map((column) => (
              <Table.Head key={column}>{column}</Table.Head>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((row, rowIndex) => (
            <Table.Row key={rowIndex}>
              {columns.map((column) => (
                <Table.Cell key={column}>{cellText(row[column])}</Table.Cell>
              ))}
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

function AgentsListPage() {
  const [agents, setAgents] = useState<LibraryAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchJson<LibraryAgentListResponse>("/api/agents")
      .then((data) => setAgents(data.agents))
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <section className="content-band">
      <header className="section-header">
        <div>
          <p className="eyebrow">Agents</p>
          <h1>Multi-sheet agents</h1>
        </div>
        <Link to="/agents/new" className="primary-link">
          <Plus size={18} />
          <span>Create agent</span>
        </Link>
      </header>
      {isLoading ? (
        <div className="status-line"><Loader size="sm" /><span>Loading agents</span></div>
      ) : error ? (
        <Banner variant="error" title="Could not load agents" description={error} />
      ) : agents.length === 0 ? (
        <Empty className="empty-list" icon={<Bot size={42} />} title="No agents yet" description="Create an agent from ready Data Library sheets." />
      ) : (
        <div className="spreadsheet-list">
          {agents.map((agent) => (
            <Link className="spreadsheet-row" key={agent.id} params={{ agentId: agent.id }} to="/agents/$agentId">
              <Bot size={22} />
              <div>
                <h2>{agent.name}</h2>
                <p>{agent.description || "No description"}</p>
                <div className="row-badges">
                  <Badge appearance="dot" variant={statusVariant(agent.status)}>{agent.status ?? "ready"}</Badge>
                  <Badge variant="teal-subtle">{agent.sheet_count ?? 0} sheets</Badge>
                </div>
                {agent.error_message ? <p className="row-error">{agent.error_message}</p> : null}
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function CreateAgentPage() {
  const navigate = useNavigate();
  const [spreadsheets, setSpreadsheets] = useState<Spreadsheet[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchJson<SpreadsheetListResponse>("/api/spreadsheets")
      .then((data) => setSpreadsheets(data.spreadsheets))
      .catch((caught: Error) => setError(caught.message));
  }, []);

  const readySheets = spreadsheets.filter((sheet) => sheet.status === "ready" && sheet.pre_extract !== 0);
  const grouped = readySheets.reduce<Array<{ category: string; items: Spreadsheet[] }>>((groups, sheet) => {
    const category = sheet.category || "Uncategorised";
    const group = groups.find((item) => item.category === category);
    if (group) group.items.push(sheet);
    else groups.push({ category, items: [sheet] });
    return groups;
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      const data = await fetchJson<LibraryAgentResponse>("/api/agents", {
        body: JSON.stringify({ description, name, spreadsheetIds: selected }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await navigate({ params: { agentId: data.agent.id }, to: "/agents/$agentId" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Agent creation failed");
    } finally {
      setIsSaving(false);
    }
  }

  function toggle(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }

  return (
    <section className="content-band narrow">
      <Link to="/agents" className="back-link"><ArrowLeft size={18} /><span>Agents</span></Link>
      <header className="section-header"><div><p className="eyebrow">Agents</p><h1>Create multi-sheet agent</h1></div></header>
      <form className="upload-form" onSubmit={submit}>
        <label className="form-field"><span>Name</span><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Budget review agent" /></label>
        <label className="form-field"><span>Description</span><Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this agent is for" /></label>
        <div className="source-panel">
          <p className="eyebrow">Data Library sheets</p>
          {grouped.map((group) => (
            <section className="checkbox-group" key={group.category}>
              <h2>{group.category}</h2>
              {group.items.map((sheet) => (
                <label key={sheet.id} className="checkbox-row">
                  <input type="checkbox" checked={selected.includes(sheet.id)} onChange={() => toggle(sheet.id)} />
                  <span>{sheet.filename}</span>
                </label>
              ))}
            </section>
          ))}
        </div>
        {error ? <Banner variant="error" title="Could not create agent" description={error} /> : null}
        <Button type="submit" variant="primary" loading={isSaving} disabled={!name.trim() || selected.length === 0 || isSaving}>
          <Plus size={18} /><span>Create agent</span>
        </Button>
      </form>
    </section>
  );
}

function AgentChatPage() {
  const { agentId } = useParams({ from: "/agents/$agentId" });
  const navigate = useNavigate();
  const [agentRecord, setAgentRecord] = useState<LibraryAgent | null>(null);
  const [sheets, setSheets] = useState<Spreadsheet[]>([]);
  const [traces, setTraces] = useState<AgentTrace[]>([]);
  const [activeView, setActiveView] = useState<MultiAgentView>("chat");
  const [input, setInput] = useState("");
  const [renderedMessages, setRenderedMessages] = useState<RenderedMessage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const [analysisTables, setAnalysisTables] = useState<AnalysisTablesResponse | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<AnalysisTableResponse | null>(null);
  const [isViewerLoading, setIsViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchJson<LibraryAgentResponse>(`/api/agents/${agentId}`)
      .then((data) => {
        setAgentRecord(data.agent);
        setSheets(data.sheets);
      })
      .catch((caught: Error) => setError(caught.message));
    fetchJson<AgentTraceResponse>(`/api/agents/${agentId}/traces`).then((data) => setTraces(data.traces)).catch(() => setTraces([]));
  }, [agentId]);

  const liveAgent = useAgent({
    agent: "AgentThink",
    enabled: Boolean(agentRecord?.agent_name),
    name: agentRecord?.agent_name ?? "agent-loading",
    onMessage: (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as unknown;
        if (!isAgentTraceMessage(message)) return;
        setTraces((current) => [...current.filter((trace) => trace.id !== message.trace.id), message.trace].slice(-30));
      } catch {
        return;
      }
    },
  });
  const [isSending, setIsSending] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [isGeneratingSong, setIsGeneratingSong] = useState(false);
  const isBusy = isSending;
  const wasBusyRef = useRef(false);
  const [latestChatRun, setLatestChatRun] = useState<BenchmarkRun | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);

  useEffect(() => {
    let isMounted = true;
    fetchJson<AgentChatHistoryResponse>(`/api/agents/${agentId}/chat-history`)
      .then((data) => {
        if (!isMounted) return;
        setRenderedMessages(data.messages.map((message) => ({ id: message.id, role: message.role, text: message.text })));
      })
      .catch(() => undefined);
    return () => {
      isMounted = false;
    };
  }, [agentId]);

  useEffect(() => {
    if (activeView !== "chat") return;
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [activeView, isBusy, latestChatRun, renderedMessages.length, showEvidence]);

  useEffect(() => {
    if (activeView !== "sqlite" || !agentRecord || analysisTables) return;
    setIsViewerLoading(true);
    fetchJson<AnalysisTablesResponse>(`/api/agents/${agentId}/tables`)
      .then((data) => {
        setAnalysisTables(data);
        setSelectedTable(data.tables[0]?.table_name ?? null);
      })
      .catch((caught: Error) => setViewerError(caught.message))
      .finally(() => setIsViewerLoading(false));
  }, [activeView, agentId, agentRecord, analysisTables]);

  useEffect(() => {
    if (activeView !== "sqlite" || !selectedTable) return;
    setIsViewerLoading(true);
    fetchJson<AnalysisTableResponse>(`/api/agents/${agentId}/tables/${encodeURIComponent(selectedTable)}`)
      .then((data) => setTableData(data))
      .catch((caught: Error) => setViewerError(caught.message))
      .finally(() => setIsViewerLoading(false));
  }, [activeView, agentId, selectedTable]);

  useEffect(() => {
    if (wasBusyRef.current && !isBusy) {
      setAnalysisTables(null);
      setTableData(null);
      setSelectedTable(null);
    }
    wasBusyRef.current = isBusy;
  }, [isBusy]);

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy || !agentRecord) return;

    const totalStarted = performance.now();
    const thinkingId = crypto.randomUUID();
    setRenderedMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text }, { id: thinkingId, role: "assistant", text: "Thinking..." }]);
    setInput("");
    setIsSending(true);
    setShowEvidence(false);

    try {
      const answerStarted = performance.now();
      const answer = await fetchJson<AgentRequestResponse>(`/api/agents/${agentId}/agent-request`, {
        body: JSON.stringify({ message: text }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const run = createBenchmarkRunFromAnswer({
        answer: {
          ...answer,
          selection:
            answer.selection ??
            ({
              candidates: sheets.map((sheet) => ({
                description: `${sheet.category || "Uncategorised"} · ${formatBytes(sheet.size_bytes)} · ${extractionLabel(sheet)}`,
                filename: sheet.filename,
                id: sheet.id,
                status: sheet.status ?? "ready",
              })),
              model: answer.model,
              reason: "Multi-sheet agent chat used the attached source set, so semantic spreadsheet selection was handled by the agent context.",
              score: null,
              usage: answer.usage,
            } satisfies BenchmarkSelectionEvidence),
        },
        answerSeconds: (performance.now() - answerStarted) / 1000,
        prompt: text,
        spreadsheetFilename: agentRecord.name,
        spreadsheetId: agentId,
        totalSeconds: (performance.now() - totalStarted) / 1000,
        uploadSeconds: null,
      });
      setLatestChatRun(run);
      setRenderedMessages((current) =>
        current.map((message) =>
          message.id === thinkingId ? { benchmarkRun: run, id: answer.requestId, role: "assistant", text: answer.response } : message,
        ),
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Agent request failed";
      setRenderedMessages((current) =>
        current.map((item) => (item.id === thinkingId ? { id: thinkingId, role: "assistant", text: message } : item)),
      );
    } finally {
      setIsSending(false);
    }
  }

  async function addMessageToBenchmark(messageId: string) {
    const message = renderedMessages.find((item) => item.id === messageId);
    if (!message?.benchmarkRun || message.benchmarkSaved || message.benchmarkSaving) return;

    setRenderedMessages((current) => current.map((item) => (item.id === messageId ? { ...item, benchmarkSaving: true } : item)));
    try {
      const savedRun = await saveBenchmarkRun(message.benchmarkRun);
      setLatestChatRun(savedRun);
      setRenderedMessages((current) =>
        current.map((item) =>
          item.id === messageId ? { ...item, benchmarkRun: savedRun, benchmarkSaved: true, benchmarkSaving: false } : item,
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add benchmark run");
      setRenderedMessages((current) => current.map((item) => (item.id === messageId ? { ...item, benchmarkSaving: false } : item)));
    }
  }

  async function clearChat() {
    setRenderedMessages([]);
    setLatestChatRun(null);
    setShowEvidence(false);
    setInput("");
    await fetch(`/api/agents/${agentId}/chat-history`, { method: "DELETE" }).catch(() => undefined);
  }

  async function downloadExtractionTrace() {
    if (!agentRecord) return;
    const data = await fetchJson<AgentTraceResponse>(`/api/agents/${agentId}/extraction-trace`);
    downloadJsonFile(`${safeDownloadName(agentRecord.name)}-extraction-trace.json`, {
      agentId,
      agentName: agentRecord.agent_name,
      name: agentRecord.name,
      traces: data.traces,
    });
  }

  async function generateReport() {
    if (isGeneratingReport) return;
    setIsGeneratingReport(true);
    setError(null);
    try {
      await fetchJson<AgentReportResponse>(`/api/agents/${agentId}/report`, {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await navigate({ params: { agentId }, to: "/agents/$agentId/report" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate report");
    } finally {
      setIsGeneratingReport(false);
    }
  }

  async function generateSong() {
    if (isGeneratingSong) return;
    setIsGeneratingSong(true);
    setError(null);
    try {
      await fetchJson<AgentSongResponse>(`/api/agents/${agentId}/song`, {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      await navigate({ params: { agentId }, to: "/agents/$agentId/song" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate song");
    } finally {
      setIsGeneratingSong(false);
    }
  }

  if (error) return <section className="content-band"><Link to="/agents" className="back-link"><ArrowLeft size={18} /><span>Agents</span></Link><Banner variant="error" title="Could not load agent" description={error} /></section>;
  if (!agentRecord) return <section className="content-band"><div className="status-line"><Loader size="sm" /><span>Loading agent</span></div></section>;

  return (
    <section className="chat-page">
      <header className="chat-header">
        <Link to="/agents" className="back-link"><ArrowLeft size={18} /><span>Agents</span></Link>
        <div>
          <p className="eyebrow">{agentRecord.agent_name}</p>
          <h1>{agentRecord.name}</h1>
          <p className="muted">{sheets.length} attached sheets · {agentRecord.description || "No description"}</p>
        </div>
      </header>
      <div className="chat-stickybar">
        <div className="chat-sticky-title">
          <Bot size={18} />
          <span>{agentRecord.name}</span>
          <small>{sheets.length} attached {sheets.length === 1 ? "sheet" : "sheets"}</small>
        </div>
        <div className="chat-toolbar">
          <Link className="nav-button" params={{ agentId }} to="/agents/$agentId/report">
            <FileText size={16} />
            <span>Report</span>
          </Link>
          <Link className="nav-button" params={{ agentId }} to="/agents/$agentId/report/edit">
            <FileText size={16} />
            <span>Edit report</span>
          </Link>
          <Link className="nav-button" params={{ agentId }} to="/agents/$agentId/song">
            <Music size={16} />
            <span>Song</span>
          </Link>
          <Link className="nav-button" params={{ agentId }} to="/agents/$agentId/song/edit">
            <Music size={16} />
            <span>Edit song</span>
          </Link>
          <Button
            disabled={isGeneratingReport}
            icon={<FileText size={16} />}
            loading={isGeneratingReport}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void generateReport()}
          >
            Generate report
          </Button>
          <Button
            disabled={isGeneratingSong}
            icon={<Music size={16} />}
            loading={isGeneratingSong}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => void generateSong()}
          >
            Generate song
          </Button>
          <Tabs
            className="view-tabs"
            size="sm"
            value={activeView}
            variant="segmented"
            tabs={[
              { label: <span className="tab-label"><Bot size={16} /> Chat</span>, value: "chat" },
              { label: <span className="tab-label"><Database size={16} /> SQLite</span>, value: "sqlite" },
              { label: <span className="tab-label"><Layers3 size={16} /> Sources</span>, value: "sources" },
            ]}
            onValueChange={(value) => setActiveView(value as MultiAgentView)}
          />
          {activeView === "chat" ? (
            <>
            <Button
              disabled={!latestChatRun}
              icon={<Search size={16} />}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => setShowEvidence((value) => !value)}
            >
              {showEvidence ? "Hide evidence" : "Evidence"}
            </Button>
            <Button
              disabled={isBusy || renderedMessages.length === 0}
              icon={<Trash2 size={16} />}
              size="sm"
              type="button"
              variant="secondary-destructive"
              onClick={clearChat}
            >
              Clear chat
            </Button>
            </>
          ) : null}
        </div>
      </div>
      <div className="chat-main">
        <div className="chat-workspace">
          {activeView === "chat" ? (
            <>
              <div className="messages">
                <div className="attached-sheets">
                  {sheets.map((sheet) => <Badge key={sheet.id} variant="teal-subtle">{sheet.category}: {sheet.filename}</Badge>)}
                </div>
                {renderedMessages.length === 0 ? (
                  <Empty className="empty-state" icon={<Bot size={38} />} size="sm" title="Agent ready" description="Ask across the copied SQLite working database." />
                ) : renderedMessages.map((message, index) => (
                  <ChatMessage
                    key={message.id}
                    isStreaming={isBusy && message.role === "assistant" && index === renderedMessages.length - 1}
                    message={message}
                    onAddToBenchmark={addMessageToBenchmark}
                  />
                ))}
                {showEvidence && latestChatRun ? <EvidenceViewer run={latestChatRun} /> : null}
                <div ref={messagesEndRef} />
              </div>
              <form className="composer" onSubmit={submitMessage}>
                <Input aria-label="Message" value={input} onChange={(event) => setInput(event.target.value)} />
                <VoiceInputButton disabled={isBusy} value={input} onTranscript={setInput} />
                <Button aria-label="Send message" className="icon-button" loading={isBusy} shape="square" type="submit" variant="primary" disabled={isBusy || !input.trim()}><Send size={18} /></Button>
              </form>
            </>
          ) : null}

          {activeView === "sqlite" ? (
            <SQLiteViewer
              analysisTables={analysisTables}
              error={viewerError}
              isLoading={isViewerLoading}
              selectedTable={selectedTable}
              setSelectedTable={setSelectedTable}
              tableData={tableData}
            />
          ) : null}

          {activeView === "sources" ? <AgentSourcesView sheets={sheets} /> : null}
        </div>
        <aside className="trace-panel">
          <header>
            <div className="trace-heading"><p className="eyebrow">Trace</p><h2>Agent steps</h2></div>
            <Button
              aria-label="Download extraction trace"
              className="trace-toggle"
              shape="square"
              size="sm"
              onClick={() => void downloadExtractionTrace()}
              title="Download extraction trace"
              type="button"
              variant="secondary"
            >
              <Download size={18} />
            </Button>
          </header>
          <div className="trace-content">
            {traces.length === 0 ? <p className="trace-empty">No agent steps yet.</p> : (
              <ol className="trace-list">
                {traces.map((trace) => {
                  const detail = formatTraceDetail(trace.detail);
                  return <li className={`trace-item ${trace.status}`} key={trace.id}><div><span className="trace-dot" /></div><article><div className="trace-title-row"><h3>{trace.title}</h3>{trace.duration_ms ? <span>{trace.duration_ms}ms</span> : null}</div><p>{trace.span_type}</p>{detail ? <pre>{detail}</pre> : null}</article></li>;
                })}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function AgentSourcesView({ sheets }: { sheets: Spreadsheet[] }) {
  return (
    <section className="data-viewer agent-sources-view">
      <header className="viewer-header">
        <div>
          <p className="eyebrow">Sources</p>
          <h2>{sheets.length} attached {sheets.length === 1 ? "sheet" : "sheets"}</h2>
        </div>
      </header>

      {sheets.length === 0 ? (
        <Empty
          className="viewer-empty"
          icon={<Layers3 size={32} />}
          size="sm"
          title="No source sheets"
          description="Attach Data Library sheets to build a multi-sheet agent."
        />
      ) : (
        <div className="agent-source-grid">
          {sheets.map((sheet) => (
            <Link
              className="agent-source-card"
              key={sheet.id}
              params={{ spreadsheetId: sheet.id }}
              to="/spreadsheets/$spreadsheetId"
            >
              <div className="agent-source-icon"><FileSpreadsheet size={20} /></div>
              <div className="agent-source-body">
                <div className="agent-source-title-row">
                  <h3>{sheet.filename}</h3>
                  <Badge variant={sheet.status === "failed" ? "error" : "teal-subtle"}>{sheet.status ?? "ready"}</Badge>
                </div>
                <p>{sheet.category || "Uncategorised"} · {formatBytes(sheet.size_bytes)} · {extractionLabel(sheet)}</p>
                <small>{sheet.agent_name}</small>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function AgentReportPage() {
  const { agentId } = useParams({ from: "/agents/$agentId/report" });
  return <AgentReportView agentId={agentId} mode="public" />;
}

function AgentReportEditPage() {
  const { agentId } = useParams({ from: "/agents/$agentId/report/edit" });
  return <AgentReportView agentId={agentId} mode="edit" />;
}

function AgentSongPage() {
  const { agentId } = useParams({ from: "/agents/$agentId/song" });
  return <AgentSongView agentId={agentId} mode="public" />;
}

function AgentSongEditPage() {
  const { agentId } = useParams({ from: "/agents/$agentId/song/edit" });
  return <AgentSongView agentId={agentId} mode="edit" />;
}

function AgentReportView({ agentId, mode }: { agentId: string; mode: "edit" | "public" }) {
  const [agentRecord, setAgentRecord] = useState<LibraryAgent | null>(null);
  const [report, setReport] = useState<AgentReport | null>(null);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    let isMounted = true;
    async function loadReport() {
      try {
        const [agentData, reportData] = await Promise.all([
          fetchJson<LibraryAgentResponse>(`/api/agents/${agentId}`),
          fetchJson<AgentReportResponse>(`/api/agents/${agentId}/report`),
        ]);
        if (!isMounted) return;
        setAgentRecord(agentData.agent);
        setReport(reportData.report);
        setPrompt(reportData.report?.prompt ?? "");
        setError(null);
      } catch (caught) {
        if (isMounted) setError(caught instanceof Error ? caught.message : "Could not load report");
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    void loadReport();
    return () => {
      isMounted = false;
    };
  }, [agentId]);

  async function generateReport(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (isGenerating) return;
    setIsGenerating(true);
    setError(null);
    try {
      const data = await fetchJson<AgentReportResponse>(`/api/agents/${agentId}/report`, {
        body: JSON.stringify({ prompt }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      setReport(data.report);
      if (data.report?.prompt) setPrompt(data.report.prompt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate report");
    } finally {
      setIsGenerating(false);
    }
  }

  const reportSpec = isJsonRenderSpec(report?.spec) ? report.spec : null;
  const isPublic = mode === "public";

  return (
    <section className={isPublic ? "report-public-page" : "content-band report-page"}>
      {isPublic ? null : (
        <Link to="/agents/$agentId" params={{ agentId }} className="back-link">
          <ArrowLeft size={18} />
          <span>Agent</span>
        </Link>
      )}
      <header className={isPublic ? "report-public-header" : "section-header"}>
        <div>
          <p className="eyebrow">{isPublic ? "XLSX Song report" : "Agent report"}</p>
          <h1>{report?.title || agentRecord?.name || "Report"}</h1>
          <p className="muted">
            {agentRecord?.name ?? agentId}
            {report?.generatedAt ? ` · generated ${formatDateTime(report.generatedAt)}` : ""}
          </p>
        </div>
        {isPublic ? null : (
          <div className="report-actions">
            <Link className="nav-button" params={{ agentId }} to="/agents/$agentId/report">
              <FileText size={16} />
              <span>View share page</span>
            </Link>
            <Button
              disabled={isGenerating}
              icon={<FileText size={18} />}
              loading={isGenerating}
              type="button"
              variant="primary"
              onClick={() => void generateReport()}
            >
              {report ? "Regenerate" : "Generate report"}
            </Button>
          </div>
        )}
      </header>

      {report?.isStale ? (
        <Banner
          title="New agent data available"
          description={`This report was generated before the agent data was last updated${
            report.latestDataUpdatedAt ? ` (${formatDateTime(report.latestDataUpdatedAt)})` : ""
          }. Regenerate it from the edit report page to include the latest data.`}
        />
      ) : null}

      {isPublic ? null : (
        <form className="report-prompt" onSubmit={generateReport}>
          <label className="form-field">
            <span>Steer the report</span>
            <Input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <Button disabled={isGenerating} loading={isGenerating} type="submit" variant="secondary">
            Regenerate with prompt
          </Button>
        </form>
      )}

      {error ? <Banner variant="error" title="Report error" description={error} /> : null}
      {isLoading ? (
        <div className="status-line">
          <Loader size="sm" />
          <span>Loading report</span>
        </div>
      ) : reportSpec ? (
        <article className={isPublic ? "report-public-artifact" : "report-artifact"}>
          <JsonRenderReport spec={reportSpec} />
        </article>
      ) : (
        <Empty
          className="empty-list"
          icon={<FileText size={42} />}
          title="No report generated yet"
          description={
            isPublic
              ? "This agent does not have a published report yet."
              : "Generate a report from this agent's current working database."
          }
          contents={isPublic ? undefined : (
            <Button disabled={isGenerating} loading={isGenerating} type="button" variant="primary" onClick={() => void generateReport()}>
              Generate report
            </Button>
          )}
        />
      )}
    </section>
  );
}

function AgentSongView({ agentId, mode }: { agentId: string; mode: "edit" | "public" }) {
  const [agentRecord, setAgentRecord] = useState<LibraryAgent | null>(null);
  const [song, setSong] = useState<AgentSong | null>(null);
  const [prompt, setPrompt] = useState("");
  const [lengthSeconds, setLengthSeconds] = useState(45);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    let isMounted = true;
    async function loadSong() {
      try {
        const [agentData, songData] = await Promise.all([
          fetchJson<LibraryAgentResponse>(`/api/agents/${agentId}`),
          fetchJson<AgentSongResponse>(`/api/agents/${agentId}/song`),
        ]);
        if (!isMounted) return;
        setAgentRecord(agentData.agent);
        setSong(songData.song);
        setPrompt(songData.song?.prompt ?? "");
        setError(null);
      } catch (caught) {
        if (isMounted) setError(caught instanceof Error ? caught.message : "Could not load song");
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    void loadSong();
    return () => {
      isMounted = false;
    };
  }, [agentId]);

  async function generateSong(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (isGenerating) return;
    setIsGenerating(true);
    setError(null);
    try {
      const data = await fetchJson<AgentSongResponse>(`/api/agents/${agentId}/song`, {
        body: JSON.stringify({ lengthMs: lengthSeconds * 1000, prompt }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      setSong(data.song);
      if (data.song?.prompt) setPrompt(data.song.prompt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not generate song");
    } finally {
      setIsGenerating(false);
    }
  }

  const isPublic = mode === "public";
  const audioUrl = song ? `${song.audioUrl}?v=${encodeURIComponent(song.updatedAt)}` : "";

  return (
    <section className={isPublic ? "report-public-page song-public-page" : "content-band report-page song-page"}>
      {isPublic ? null : (
        <Link to="/agents/$agentId" params={{ agentId }} className="back-link">
          <ArrowLeft size={18} />
          <span>Agent</span>
        </Link>
      )}
      <header className={isPublic ? "report-public-header" : "section-header"}>
        <div>
          <p className="eyebrow">{isPublic ? "XLSX Song" : "Agent song"}</p>
          <h1>{song?.title || agentRecord?.name || "Song"}</h1>
          <p className="muted">
            {agentRecord?.name ?? agentId}
            {song?.generatedAt ? ` · generated ${formatDateTime(song.generatedAt)}` : ""}
          </p>
        </div>
        {isPublic ? null : (
          <div className="report-actions">
            <Link className="nav-button" params={{ agentId }} to="/agents/$agentId/song">
              <Music size={16} />
              <span>View share page</span>
            </Link>
            {song ? (
              <a className="nav-button" href={audioUrl} download>
                <Download size={16} />
                <span>Download audio</span>
              </a>
            ) : null}
            <Button
              disabled={isGenerating}
              icon={<Music size={18} />}
              loading={isGenerating}
              type="button"
              variant="primary"
              onClick={() => void generateSong()}
            >
              {song ? "Regenerate" : "Generate song"}
            </Button>
          </div>
        )}
      </header>

      {song?.isStale ? (
        <Banner
          title="New agent data available"
          description={`This song was generated before the agent data was last updated${
            song.latestDataUpdatedAt ? ` (${formatDateTime(song.latestDataUpdatedAt)})` : ""
          }. Regenerate it from the edit song page to include the latest data.`}
        />
      ) : null}

      {isPublic ? null : (
        <form className="report-prompt" onSubmit={generateSong}>
          <label className="form-field">
            <span>Steer the song</span>
            <Input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Make it a witty synth-pop song about the biggest changes and surprising facts."
            />
          </label>
          <label className="form-field song-length-field">
            <span>Length seconds</span>
            <Input
              value={String(lengthSeconds)}
              onChange={(event) => setLengthSeconds(Math.max(10, Math.min(120, Number(event.target.value) || 45)))}
            />
          </label>
          <Button disabled={isGenerating} loading={isGenerating} type="submit" variant="secondary">
            Regenerate with prompt
          </Button>
        </form>
      )}

      {error ? <Banner variant="error" title="Song error" description={error} /> : null}
      {isLoading ? (
        <div className="status-line">
          <Loader size="sm" />
          <span>Loading song</span>
        </div>
      ) : song ? (
        <article className="song-artifact">
          <section className="song-player-panel">
            <div className="song-icon">
              <Music size={32} />
            </div>
            <div>
              <p className="eyebrow">Generated audio</p>
              <h2>{song.title || "Agent song"}</h2>
              <p className="muted">{song.modelId} · {song.outputFormat}</p>
            </div>
            <audio controls src={audioUrl} />
            {isPublic ? (
              <a className="nav-button" href={audioUrl} download>
                <Download size={16} />
                <span>Download audio</span>
              </a>
            ) : null}
          </section>

          <section className="song-details-grid">
            <article>
              <p className="eyebrow">Facts used</p>
              {song.facts.length > 0 ? (
                <ul>
                  {song.facts.map((fact, index) => <li key={`${fact}-${index}`}>{fact}</li>)}
                </ul>
              ) : (
                <p className="muted">No extracted facts were returned with this song.</p>
              )}
            </article>
            <article>
              <p className="eyebrow">Music prompt</p>
              <pre>{song.musicPrompt}</pre>
            </article>
          </section>
        </article>
      ) : (
        <Empty
          className="empty-list"
          icon={<Music size={42} />}
          title="No song generated yet"
          description={
            isPublic
              ? "This agent does not have a published song yet."
              : "Generate a song from this agent's current working database."
          }
          contents={isPublic ? undefined : (
            <Button disabled={isGenerating} loading={isGenerating} type="button" variant="primary" onClick={() => void generateSong()}>
              Generate song
            </Button>
          )}
        />
      )}
    </section>
  );
}

function AskDataPage() {
  const [input, setInput] = useState("Find a relevant public dataset and answer my question.");
  const [messages, setMessages] = useState<RenderedMessage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const [latestRun, setLatestRun] = useState<BenchmarkRun | null>(null);
  const [steps, setSteps] = useState<DatasetAgentStep[]>([]);
  const [showEvidence, setShowEvidence] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [pendingAnswers, setPendingAnswers] = useState<PendingDatasetAnswer[]>([]);

  async function saveCompletedAnswer(answer: AgentRequestResponse, pending: PendingDatasetAnswer) {
    setSteps(answer.steps ?? []);
    const run = createBenchmarkRunFromAnswer({
      answer,
      answerSeconds: (performance.now() - pending.answerStartedAt) / 1000,
      prompt: pending.prompt,
      spreadsheetFilename: answer.selectedSpreadsheet?.filename ?? answer.importedSpreadsheet?.filename ?? pending.spreadsheetFilename,
      spreadsheetId: answer.selectedSpreadsheet?.id ?? answer.importedSpreadsheet?.id ?? pending.spreadsheetId,
      totalSeconds: (performance.now() - pending.totalStartedAt) / 1000,
      uploadSeconds: null,
    });
    const savedRun = await saveBenchmarkRun(run);
    setLatestRun(savedRun);
  }

  useEffect(() => {
    if (pendingAnswers.length === 0) return undefined;

    let cancelled = false;
    const timers = new Set<number>();

    pendingAnswers.forEach((pending) => {
      const poll = async () => {
        try {
          const answer = await fetchJson<AgentRequestResponse>("/api/dataset-agent/pending-answer", {
            body: JSON.stringify({ message: pending.prompt, spreadsheetId: pending.spreadsheetId }),
            headers: { "content-type": "application/json" },
            method: "POST",
          });
          if (cancelled) return;

          if (answer.finishReason === "import_pending") {
            setSteps(answer.steps ?? []);
            const timer = window.setTimeout(poll, 10_000);
            timers.add(timer);
            return;
          }

          setPendingAnswers((current) => current.filter((item) => item.messageId !== pending.messageId));
          setMessages((current) => current.map((message) => (message.id === pending.messageId ? { ...message, text: answer.response } : message)));
          await saveCompletedAnswer(answer, pending);
        } catch (caught) {
          if (cancelled) return;
          const message = caught instanceof Error ? caught.message : "Dataset answer failed";
          setPendingAnswers((current) => current.filter((item) => item.messageId !== pending.messageId));
          setSteps((current) => [...current, { detail: message, status: "error", title: "Dataset answer failed" }]);
          setMessages((current) => current.map((item) => (item.id === pending.messageId ? { ...item, text: message } : item)));
        }
      };

      const timer = window.setTimeout(poll, 10_000);
      timers.add(timer);
    });

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [pendingAnswers]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [isRunning, latestRun, messages.length, showEvidence, steps.length]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isRunning) return;

    const totalStarted = performance.now();
    const thinkingId = crypto.randomUUID();
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text }, { id: thinkingId, role: "assistant", text: "Thinking..." }]);
    setInput("");
    setSteps([{ status: "running", title: "Starting dataset search" }]);
    setIsRunning(true);
    setShowEvidence(false);

    try {
      const answerStarted = performance.now();
      const answer = await fetchJson<AgentRequestResponse>("/api/dataset-agent/request", {
        body: JSON.stringify({ message: text }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      setSteps(answer.steps ?? []);
      if (answer.finishReason === "import_pending" && answer.importedSpreadsheet) {
        const messageId = answer.requestId;
        const importedSpreadsheet = answer.importedSpreadsheet;
        setMessages((current) => [...current, { id: messageId, role: "assistant", text: answer.response }]);
        setPendingAnswers((current) => [
          ...current,
          {
            answerStartedAt: performance.now(),
            messageId,
            prompt: text,
            spreadsheetFilename: importedSpreadsheet.filename,
            spreadsheetId: importedSpreadsheet.id,
            totalStartedAt: totalStarted,
          },
        ]);
        return;
      }
      const run = createBenchmarkRunFromAnswer({
        answer,
        answerSeconds: (performance.now() - answerStarted) / 1000,
        prompt: text,
        spreadsheetFilename: answer.selectedSpreadsheet?.filename ?? answer.importedSpreadsheet?.filename ?? "dataset-agent",
        spreadsheetId: answer.selectedSpreadsheet?.id ?? answer.importedSpreadsheet?.id ?? "dataset-agent",
        totalSeconds: (performance.now() - totalStarted) / 1000,
        uploadSeconds: null,
      });
      const savedRun = await saveBenchmarkRun(run);
      setLatestRun(savedRun);
      setMessages((current) =>
        current.map((message) => (message.id === thinkingId ? { id: answer.requestId, role: "assistant", text: answer.response } : message)),
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Dataset agent request failed";
      setSteps((current) => [...current, { detail: message, status: "error", title: "Dataset search failed" }]);
      setMessages((current) =>
        current.map((item) => (item.id === thinkingId ? { id: thinkingId, role: "assistant", text: message } : item)),
      );
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <section className="chat-page dataset-chat-page">
      <header className="chat-header">
        <Link to="/" className="back-link"><ArrowLeft size={18} /><span>Spreadsheets</span></Link>
        <div>
          <p className="eyebrow">Dataset agent</p>
          <h1>Ask across local and public data</h1>
          <p className="muted">The agent checks local uploaded datasets first, then searches data.gov.uk if needed.</p>
        </div>
        <div className="chat-toolbar">
          <Button disabled={!latestRun} icon={<Search size={16} />} size="sm" type="button" variant="secondary" onClick={() => setShowEvidence((value) => !value)}>
            {showEvidence ? "Hide evidence" : "Evidence"}
          </Button>
          <Button
            disabled={isRunning || messages.length === 0}
            icon={<Trash2 size={16} />}
            size="sm"
            type="button"
            variant="secondary-destructive"
            onClick={() => {
              setMessages([]);
              setLatestRun(null);
              setSteps([]);
              setPendingAnswers([]);
              setShowEvidence(false);
            }}
          >
            Clear chat
          </Button>
        </div>
      </header>

      <div className="chat-main">
        <div className="chat-workspace">
          <div className="messages">
            {messages.length === 0 ? (
              <Empty className="empty-state" icon={<Search size={38} />} size="sm" title="Dataset agent ready" description="Ask a question and I will find the best local or data.gov.uk dataset." />
            ) : messages.map((message) => <ChatMessage key={message.id} isStreaming={false} message={message} />)}
            {showEvidence && latestRun ? <EvidenceViewer run={latestRun} /> : null}
            <div ref={messagesEndRef} />
          </div>
          <form className="composer" onSubmit={submit}>
            <Input aria-label="Message" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask for data..." />
            <Button aria-label="Send message" className="icon-button" loading={isRunning} shape="square" type="submit" variant="primary" disabled={isRunning || !input.trim()}>
              <Send size={18} />
            </Button>
          </form>
        </div>
        <aside className="trace-panel">
          <header>
            <div className="trace-heading"><p className="eyebrow">Trace</p><h2>Dataset search</h2></div>
          </header>
          <div className="trace-content">
            {steps.length === 0 ? <p className="trace-empty">No search steps yet.</p> : (
              <ol className="trace-list">
                {steps.map((step, index) => (
                  <li className={`trace-item ${step.status}`} key={`${step.title}-${index}`}>
                    <div><span className="trace-dot" /></div>
                    <article>
                      <div className="trace-title-row"><h3>{step.title}</h3></div>
                      <p>{step.status}</p>
                      {step.detail !== undefined ? <pre>{typeof step.detail === "string" ? step.detail : JSON.stringify(step.detail, null, 2)}</pre> : null}
                    </article>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function BenchmarkDashboardPage() {
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function syncRuns() {
      try {
        const data = await fetchJson<BenchmarkRunsResponse>("/api/benchmarks/runs");
        setRuns(data.runs);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not load benchmark runs");
      } finally {
        setIsLoading(false);
      }
    }

    void syncRuns();
    window.addEventListener("benchmark-runs-updated", syncRuns);
    return () => {
      window.removeEventListener("benchmark-runs-updated", syncRuns);
    };
  }, []);

  const completedRuns = runs.filter((run) => !run.error);
  const averageAnswerSeconds = average(completedRuns.map((run) => run.answerSeconds));
  const averageTotalTokens = average(completedRuns.map((run) => run.totalTokens));
  const averageQuality = average(completedRuns.map((run) => run.quality));

  async function setQuality(runId: string, quality: number) {
    setRuns((current) => current.map((run) => (run.id === runId ? { ...run, quality } : run)));
    try {
      await updateBenchmarkRunQuality(runId, quality);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save quality score");
    }
  }

  async function clearRuns() {
    try {
      await fetchJson<{ ok: true }>("/api/benchmarks/runs", { method: "DELETE" });
      setRuns([]);
      window.dispatchEvent(new CustomEvent("benchmark-runs-updated"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not clear benchmark runs");
    }
  }

  async function deleteRun(runId: string) {
    const previousRuns = runs;
    setRuns((current) => current.filter((run) => run.id !== runId));
    try {
      await deleteBenchmarkRun(runId);
    } catch (caught) {
      setRuns(previousRuns);
      setError(caught instanceof Error ? caught.message : "Could not delete benchmark run");
    }
  }

  return (
    <section className="benchmark-page analytics-page">
      <aside className="analytics-sidebar">
        <Link to="/" className="back-link">
          <ArrowLeft size={18} />
          <span>Spreadsheets</span>
        </Link>

        <section className="source-panel">
          <p className="eyebrow">Benchmark log</p>
          <h2>{runs.length} captured {runs.length === 1 ? "run" : "runs"}</h2>
          <p className="muted">Runs are captured when prompts are answered in a spreadsheet or multi-sheet chat canvas.</p>
        </section>

        <section className="source-panel">
          <p className="eyebrow">Saved in D1</p>
          <h2>benchmark_runs</h2>
          <p className="muted">The benchmark log is persisted in the Cloudflare D1 database, not browser localStorage.</p>
        </section>

        <Button className="clear-button" type="button" onClick={clearRuns} disabled={runs.length === 0} variant="secondary">
          <Trash2 size={16} />
          <span>Clear runs</span>
        </Button>
      </aside>

      <main className="analytics-main">
        <header className="analytics-title">
          <div>
            <p className="eyebrow">Model analytics</p>
            <h1>Benchmark run log</h1>
          </div>
        </header>

        <section className="metric-grid">
          <MetricCard icon={<Gauge size={18} />} label="Runs" value={String(completedRuns.length)} />
          <MetricCard icon={<Clock size={18} />} label="Avg answer speed" value={formatSeconds(averageAnswerSeconds)} />
          <MetricCard icon={<BarChart3 size={18} />} label="Avg tokens" value={formatNumber(averageTotalTokens === null ? null : Math.round(averageTotalTokens))} />
          <MetricCard icon={<Star size={18} />} label="Avg quality" value={averageQuality === null ? "n/a" : `${averageQuality.toFixed(1)}/5`} />
        </section>

        {error ? <Banner variant="error" title="Benchmark log error" description={error} /> : null}
        {isLoading ? <div className="status-line"><Loader size="sm" /><span>Loading benchmark runs</span></div> : null}
        <BenchmarkResults deleteRun={deleteRun} runs={runs} setQuality={setQuality} />
      </main>
    </section>
  );
}

function EvidenceViewer({ run }: { run?: BenchmarkRun }) {
  const evidence = run?.evidence;
  const candidates = evidence?.candidates ?? [];
  const selectionTokens =
    tokenCount(evidence?.usage ?? undefined, ["totalTokens", "total_tokens"]) ??
    tokenCount(evidence?.usage ?? undefined, ["inputTokens", "promptTokens", "prompt_tokens", "input_tokens"]);

  return (
    <article className="evidence-card">
      <header>
        <div>
          <p className="eyebrow">Evidence</p>
          <h2>{run ? run.spreadsheetFilename ?? run.spreadsheetId : "No answer yet"}</h2>
        </div>
        {evidence?.score !== undefined && evidence.score !== null ? <span className="score-pill">{Math.round(evidence.score * 100)}%</span> : null}
      </header>

      {!run ? (
        <p className="evidence-empty">Semantic selection, source candidates, and reasoning will appear with the answer.</p>
      ) : (
        <>
          <p className="evidence-reason">{evidence?.reason ?? "No semantic selection reason was returned for this run."}</p>
          <dl className="evidence-meta">
            <div>
              <dt>Request</dt>
              <dd>{run.requestId ?? "n/a"}</dd>
            </div>
            <div>
              <dt>Selection model</dt>
              <dd>{evidence?.model ? aiModelLabel(evidence.model as AiModelOption) : `${run.modelProvider ?? "n/a"} · ${run.modelName ?? "n/a"}`}</dd>
            </div>
            <div>
              <dt>Selection time</dt>
              <dd>{typeof evidence?.durationMs === "number" ? `${evidence.durationMs}ms` : "n/a"}</dd>
            </div>
            <div>
              <dt>Selection tokens</dt>
              <dd>{formatNumber(selectionTokens)}</dd>
            </div>
          </dl>

          {candidates.length > 0 ? (
            <div className="evidence-candidates">
              {candidates.slice(0, 4).map((candidate) => (
                <article key={candidate.id}>
                  <h3>{candidate.filename}</h3>
                  <p>{candidate.description ?? `${candidate.rowCount ?? 0} rows across ${candidate.tables?.length ?? 0} tables.`}</p>
                  <small>
                    {candidate.status ?? "ready"} · {candidate.columns?.slice(0, 6).join(", ") || "metadata match"}
                  </small>
                </article>
              ))}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

function MetricCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <article className="metric-card">
      <div>{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function BenchmarkResults({
  deleteRun,
  runs,
  setQuality,
}: {
  deleteRun: (runId: string) => void;
  runs: BenchmarkRun[];
  setQuality: (runId: string, quality: number) => void;
}) {
  const [reviewRun, setReviewRun] = useState<BenchmarkRun | null>(null);

  if (runs.length === 0) {
    return (
      <div className="benchmark-empty">
        <BarChart3 size={28} />
        <p>No benchmark runs yet.</p>
      </div>
    );
  }

  return (
    <>
      <div className="benchmark-table-wrap">
        <table className="benchmark-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Prompt</th>
              <th>Model</th>
              <th>Speed</th>
              <th>Tokens</th>
              <th>Quality</th>
              <th>Answer</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr className={run.error ? "failed" : ""} key={run.id}>
                <td>
                  <strong>{new Date(run.timestamp).toLocaleTimeString()}</strong>
                  <span>{run.spreadsheetFilename ?? run.spreadsheetId}</span>
                </td>
                <td>{run.prompt}</td>
                <td>
                  <strong>{run.modelProvider ?? "n/a"}</strong>
                  <span>{run.modelName ?? "n/a"}</span>
                  <span>{benchmarkAccessMode(run)}</span>
                </td>
                <td>
                  <strong>{formatSeconds(run.answerSeconds)}</strong>
                  <span>total {formatSeconds(run.totalSeconds)}</span>
                  {run.uploadSeconds !== null ? <span>upload {formatSeconds(run.uploadSeconds)}</span> : null}
                </td>
                <td>
                  <strong>{formatNumber(run.totalTokens)}</strong>
                  <span>in {formatNumber(run.inputTokens)} · out {formatNumber(run.outputTokens)}</span>
                  <span>cost {formatCurrency(run.evidence?.estimatedCostUsd)}</span>
                </td>
                <td>
                  <QualityButtons quality={run.quality} runId={run.id} setQuality={setQuality} />
                </td>
                <td>
                  {run.error ? (
                    <span className="row-error">{run.error}</span>
                  ) : (
                    <div className="benchmark-answer-preview">
                      <p>{benchmarkAnswerPreview(run.answer)}</p>
                      <Button icon={<Search size={15} />} size="sm" type="button" variant="secondary" onClick={() => setReviewRun(run)}>
                        Open
                      </Button>
                    </div>
                  )}
                </td>
                <td>
                  <div className="benchmark-row-actions">
                    <Button icon={<Search size={15} />} size="sm" type="button" variant="secondary" onClick={() => setReviewRun(run)}>
                      Review
                    </Button>
                    <Button
                      aria-label="Delete benchmark run"
                      icon={<Trash2 size={15} />}
                      size="sm"
                      type="button"
                      variant="secondary-destructive"
                      onClick={() => deleteRun(run.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {reviewRun ? <BenchmarkReviewModal run={reviewRun} setQuality={setQuality} onClose={() => setReviewRun(null)} /> : null}
    </>
  );
}

function QualityButtons({
  quality,
  runId,
  setQuality,
}: {
  quality: number | null;
  runId: string;
  setQuality: (runId: string, quality: number) => void;
}) {
  return (
    <div className="quality-buttons" aria-label="Answer quality rating">
      {[1, 2, 3, 4, 5].map((score) => (
        <button className={quality === score ? "active" : ""} key={score} type="button" onClick={() => setQuality(runId, score)}>
          {score}
        </button>
      ))}
    </div>
  );
}

function benchmarkAnswerPreview(answer: string) {
  const spec = parseJsonRenderSpec(answer);
  if (spec) return "Interactive JSON UI response";
  const trimmed = answer.trim();
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}...` : trimmed || "No answer text";
}

function BenchmarkReviewModal({
  onClose,
  run,
  setQuality,
}: {
  onClose: () => void;
  run: BenchmarkRun;
  setQuality: (runId: string, quality: number) => void;
}) {
  const spec = run.error ? null : parseJsonRenderSpec(run.answer);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="benchmark-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="benchmark-modal" role="dialog" aria-modal="true" aria-labelledby="benchmark-review-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="benchmark-modal-header">
          <div>
            <p className="eyebrow">Benchmark review</p>
            <h2 id="benchmark-review-title">{run.spreadsheetFilename ?? run.spreadsheetId}</h2>
            <p>{run.prompt}</p>
          </div>
          <Button aria-label="Close benchmark review" icon={<X size={17} />} shape="square" type="button" variant="secondary" onClick={onClose} />
        </header>

        <div className="benchmark-modal-meta">
          <MetricCard icon={<Clock size={18} />} label="Answer speed" value={formatSeconds(run.answerSeconds)} />
          <MetricCard icon={<BarChart3 size={18} />} label="Tokens" value={formatNumber(run.totalTokens)} />
          <MetricCard icon={<Gauge size={18} />} label="Model" value={run.modelProvider ? `${run.modelProvider}` : "n/a"} />
          <article className="metric-card">
            <div><Star size={18} /></div>
            <span>Score</span>
            <QualityButtons quality={run.quality} runId={run.id} setQuality={setQuality} />
          </article>
        </div>

        <div className="benchmark-modal-body">
          {run.error ? (
            <Banner variant="error" title="Benchmark error" description={run.error} />
          ) : spec ? (
            <div className="benchmark-rendered-answer">
              <JsonRenderReport spec={spec} />
            </div>
          ) : (
            <pre>{run.answer}</pre>
          )}
        </div>
      </section>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  component: SpreadsheetListPage,
  getParentRoute: () => rootRoute,
  path: "/",
});

const uploadRoute = createRoute({
  component: UploadPage,
  getParentRoute: () => rootRoute,
  path: "/upload",
});

const askRoute = createRoute({
  component: AskDataPage,
  getParentRoute: () => rootRoute,
  path: "/ask",
});

const agentsRoute = createRoute({
  component: AgentsListPage,
  getParentRoute: () => rootRoute,
  path: "/agents",
});

const createAgentRoute = createRoute({
  component: CreateAgentPage,
  getParentRoute: () => rootRoute,
  path: "/agents/new",
});

const agentRoute = createRoute({
  component: AgentChatPage,
  getParentRoute: () => rootRoute,
  path: "/agents/$agentId",
});

const agentReportRoute = createRoute({
  component: AgentReportPage,
  getParentRoute: () => rootRoute,
  path: "/agents/$agentId/report",
});

const agentReportEditRoute = createRoute({
  component: AgentReportEditPage,
  getParentRoute: () => rootRoute,
  path: "/agents/$agentId/report/edit",
});

const agentSongRoute = createRoute({
  component: AgentSongPage,
  getParentRoute: () => rootRoute,
  path: "/agents/$agentId/song",
});

const agentSongEditRoute = createRoute({
  component: AgentSongEditPage,
  getParentRoute: () => rootRoute,
  path: "/agents/$agentId/song/edit",
});

const benchmarkRoute = createRoute({
  component: BenchmarkDashboardPage,
  getParentRoute: () => rootRoute,
  path: "/benchmarks",
});

const spreadsheetRoute = createRoute({
  component: SpreadsheetChatPage,
  getParentRoute: () => rootRoute,
  path: "/spreadsheets/$spreadsheetId",
});

const spreadsheetUploadFlowRoute = createRoute({
  component: SpreadsheetUploadFlowPage,
  getParentRoute: () => rootRoute,
  path: "/spreadsheets/$spreadsheetId/upload-flow",
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  uploadRoute,
  askRoute,
  agentsRoute,
  createAgentRoute,
  agentRoute,
  agentReportRoute,
  agentReportEditRoute,
  agentSongRoute,
  agentSongEditRoute,
  benchmarkRoute,
  spreadsheetRoute,
  spreadsheetUploadFlowRoute,
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
