import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Badge, Banner, Button, Empty, Input, Loader, Table, Tabs } from "./components/ui";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  BarChart3,
  Clock,
  Database,
  FileSpreadsheet,
  FileText,
  Gauge,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Send,
  Search,
  Sparkles,
  Star,
  Table2,
  Trash2,
  Upload,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
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

type AgentView = "chat" | "sqlite" | "raw";

type RenderedMessage = {
  id: string;
  role: string;
  text: string;
};

type AgentRequestResponse = {
  agentName: string;
  finishReason?: string;
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
  usage?: Record<string, unknown>;
};

type BenchmarkRun = {
  id: string;
  answer: string;
  answerSeconds: number;
  error?: string;
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

function isAgentTraceMessage(value: unknown): value is AgentTraceMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "agent_trace" &&
    "trace" in value
  );
}

function extractionLabel(spreadsheet: Spreadsheet) {
  return spreadsheet.pre_extract === 0 ? "Just uploaded" : "Pre-extracted";
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

function formatSeconds(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return "n/a";
  if (seconds < 10) return `${seconds.toFixed(2)}s`;
  return `${seconds.toFixed(1)}s`;
}

function formatNumber(value: number | null | undefined) {
  return value === null || value === undefined ? "n/a" : value.toLocaleString();
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
  return (
    <main className="page-shell">
      <nav className="app-nav">
        <Link to="/" className="brand">
          <FileSpreadsheet size={22} />
          <span>XLSX Song</span>
        </Link>
        <div className="nav-actions">
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
      <Outlet />
    </main>
  );
}

function SpreadsheetListPage() {
  const [spreadsheets, setSpreadsheets] = useState<Spreadsheet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const groupedSpreadsheets = spreadsheets.reduce<Array<{ category: string; items: Spreadsheet[] }>>((groups, spreadsheet) => {
    const category = spreadsheet.category || "Uncategorised";
    const group = groups.find((item) => item.category === category);
    if (group) group.items.push(spreadsheet);
    else groups.push({ category, items: [spreadsheet] });
    return groups;
  }, []);

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
      ) : (
        <div className="category-groups">
          {groupedSpreadsheets.map((group) => (
            <section className="category-group" key={group.category}>
              <header>
                <h2>{group.category}</h2>
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
                        {formatBytes(spreadsheet.size_bytes)} · {spreadsheet.agent_name}
                      </p>
                      <div className="row-badges">
                        <Badge appearance="dot" variant={statusVariant(spreadsheet.status)}>
                          {spreadsheet.status ?? "ready"}
                        </Badge>
                        <Badge variant={spreadsheet.pre_extract === 0 ? "neutral" : "teal-subtle"}>{extractionLabel(spreadsheet)}</Badge>
                      </div>
                      {spreadsheet.error_message ? <p className="row-error">{spreadsheet.error_message}</p> : null}
                    </div>
                    <div className="row-actions">
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
  useAgent({
    agent: "SheetsThink",
    enabled: Boolean(uploadAgentName),
    name: uploadAgentName ?? "upload-preview",
    onMessage: (event) => {
      if (typeof event.data !== "string") return;

      try {
        const message = JSON.parse(event.data) as unknown;
        if (!isAgentTraceMessage(message)) return;
        setUploadTraces((current) => [...current.filter((trace) => trace.id !== message.trace.id), message.trace].slice(-20));
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
          return [...traces.values()]
            .sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime())
            .slice(-30);
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

  function selectFile(nextFile: File | null) {
    setFile(nextFile);
    setError(null);
    setUploadTraces([]);
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

  return (
    <section className="content-band narrow">
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
          <span>{isUploading ? "Uploading" : "Create agent"}</span>
        </Button>

        {(isUploading || uploadTraces.length > 0) && (
          <div className="upload-steps">
            <header>
              <p className="eyebrow">{preExtract ? "Analysis" : "Upload"}</p>
              <h2>{preExtract ? "Preparing spreadsheet agent" : "Storing spreadsheet file"}</h2>
            </header>
            <ol className="upload-step-carousel" aria-label="Upload and analysis steps">
              {uploadTraces.map((trace) => {
                const detail = traceDetailParts(trace.detail);
                return (
                  <li className={`upload-step-card ${trace.status}`} key={trace.id}>
                    <span className="trace-dot" />
                    <div className="trace-title-row">
                      <h3>{trace.title}</h3>
                      {trace.duration_ms ? <span>{trace.duration_ms}ms</span> : null}
                    </div>
                    <p className="upload-step-type">{trace.span_type}</p>
                    {detail.summary ? <p className="upload-step-summary">{detail.summary}</p> : null}
                    {detail.snippet ? <pre>{detail.snippet}</pre> : detail.raw ? <pre>{detail.raw}</pre> : null}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </form>
    </section>
  );
}

function SpreadsheetChatPage() {
  const { spreadsheetId } = useParams({ from: "/spreadsheets/$spreadsheetId" });
  const [spreadsheet, setSpreadsheet] = useState<Spreadsheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("Run a simple Python script for this spreadsheet.");

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
  const { messages, sendMessage, status } = useAgentChat({ agent });
  const isBusy = status === "submitted" || status === "streaming";
  const [isTraceCollapsed, setIsTraceCollapsed] = useState(false);
  const [activeView, setActiveView] = useState<AgentView>("chat");
  const [analysisTables, setAnalysisTables] = useState<AnalysisTablesResponse | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<AnalysisTableResponse | null>(null);
  const [rawPreview, setRawPreview] = useState<RawPreviewResponse | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [isViewerLoading, setIsViewerLoading] = useState(false);
  const [isRetryingExtraction, setIsRetryingExtraction] = useState(false);
  const [renderedMessages, setRenderedMessages] = useState<RenderedMessage[]>([]);

  useEffect(() => {
    setRenderedMessages((current) => {
      const previousById = new Map(current.map((message) => [message.id, message]));
      const next = messages
        .map((message) => {
          const text = textFromMessage(message).trim();
          const previous = previousById.get(message.id);
          return {
            id: message.id,
            role: message.role,
            text: text || previous?.text || "",
          };
        })
        .filter((message) => message.text.length > 0);

      if (next.length === 0 && current.length > 0 && messages.length > 0) return current;
      return next;
    });
  }, [messages]);

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

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;
    sendMessage({ text });
    setInput("");
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
        <Tabs
          className="view-tabs"
          size="sm"
          value={activeView}
          variant="segmented"
          tabs={[
            { label: <span className="tab-label"><FileSpreadsheet size={16} /> Chat</span>, value: "chat" },
            { label: <span className="tab-label"><Database size={16} /> SQLite</span>, value: "sqlite" },
            { label: <span className="tab-label"><FileText size={16} /> Raw</span>, value: "raw" },
          ]}
          onValueChange={(value) => setActiveView(value as AgentView)}
        />
      </header>

      <div className={`chat-main ${isTraceCollapsed ? "trace-collapsed" : ""}`}>
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
                renderedMessages.map((message) => (
                  <article className={`message ${message.role}`} key={message.id}>
                    <span>{message.role}</span>
                    <p>{message.text}</p>
                  </article>
                ))
              )}
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
          ) : (
            <RawDocumentViewer error={viewerError} isLoading={isViewerLoading} rawPreview={rawPreview} />
          )}

          <form className="composer" onSubmit={submitMessage}>
            <Input
              aria-label="Message"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask this spreadsheet agent..."
            />
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
        </div>

        <aside className={`trace-panel ${isTraceCollapsed ? "is-collapsed" : ""}`}>
          <header>
            <div className="trace-heading">
              <p className="eyebrow">Trace</p>
              <h2>Agent steps</h2>
            </div>
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
  const [agentRecord, setAgentRecord] = useState<LibraryAgent | null>(null);
  const [sheets, setSheets] = useState<Spreadsheet[]>([]);
  const [traces, setTraces] = useState<AgentTrace[]>([]);
  const [input, setInput] = useState("Summarize the attached sheets.");
  const [renderedMessages, setRenderedMessages] = useState<RenderedMessage[]>([]);
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
  const { messages, sendMessage, status } = useAgentChat({ agent: liveAgent });
  const isBusy = status === "submitted" || status === "streaming";

  useEffect(() => {
    setRenderedMessages((current) => {
      const previousById = new Map(current.map((message) => [message.id, message]));
      const next = messages
        .map((message) => {
          const text = textFromMessage(message).trim();
          const previous = previousById.get(message.id);
          return { id: message.id, role: message.role, text: text || previous?.text || "" };
        })
        .filter((message) => message.text.length > 0);
      if (next.length === 0 && current.length > 0 && messages.length > 0) return current;
      return next;
    });
  }, [messages]);

  useEffect(() => {
    if (!agentRecord || analysisTables) return;
    setIsViewerLoading(true);
    fetchJson<AnalysisTablesResponse>(`/api/agents/${agentId}/tables`)
      .then((data) => {
        setAnalysisTables(data);
        setSelectedTable(data.tables[0]?.table_name ?? null);
      })
      .catch((caught: Error) => setViewerError(caught.message))
      .finally(() => setIsViewerLoading(false));
  }, [agentId, agentRecord, analysisTables]);

  useEffect(() => {
    if (!selectedTable) return;
    setIsViewerLoading(true);
    fetchJson<AnalysisTableResponse>(`/api/agents/${agentId}/tables/${encodeURIComponent(selectedTable)}`)
      .then((data) => setTableData(data))
      .catch((caught: Error) => setViewerError(caught.message))
      .finally(() => setIsViewerLoading(false));
  }, [agentId, selectedTable]);

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;
    sendMessage({ text });
    setInput("");
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
      <div className="chat-main">
        <div className="chat-workspace">
          <div className="messages">
            <div className="attached-sheets">
              {sheets.map((sheet) => <Badge key={sheet.id} variant="teal-subtle">{sheet.category}: {sheet.filename}</Badge>)}
            </div>
            {renderedMessages.length === 0 ? (
              <Empty className="empty-state" icon={<Bot size={38} />} size="sm" title="Agent ready" description="Ask across the copied SQLite working database." />
            ) : renderedMessages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}><span>{message.role}</span><p>{message.text}</p></article>
            ))}
            <SQLiteViewer analysisTables={analysisTables} error={viewerError} isLoading={isViewerLoading} selectedTable={selectedTable} setSelectedTable={setSelectedTable} tableData={tableData} />
          </div>
          <form className="composer" onSubmit={submitMessage}>
            <Input aria-label="Message" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask this multi-sheet agent..." />
            <Button aria-label="Send message" className="icon-button" loading={isBusy} shape="square" type="submit" variant="primary" disabled={isBusy || !input.trim()}><Send size={18} /></Button>
          </form>
        </div>
        <aside className="trace-panel">
          <header><div className="trace-heading"><p className="eyebrow">Trace</p><h2>Agent steps</h2></div></header>
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

function BenchmarkDashboardPage() {
  const [file, setFile] = useState<File | null>(null);
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [prompt, setPrompt] = useState("Summarize this spreadsheet and cite the most important rows.");
  const [preExtract, setPreExtract] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<BenchmarkRun[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("xlsx-song-benchmark-runs") ?? "[]") as BenchmarkRun[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem("xlsx-song-benchmark-runs", JSON.stringify(runs));
  }, [runs]);

  const completedRuns = runs.filter((run) => !run.error);
  const averageAnswerSeconds = average(completedRuns.map((run) => run.answerSeconds));
  const averageTotalTokens = average(completedRuns.map((run) => run.totalTokens));
  const averageQuality = average(completedRuns.map((run) => run.quality));
  const latestRun = completedRuns[0];
  const tokenPeak = Math.max(1, ...completedRuns.map((run) => run.totalTokens ?? 0));
  const suggestedPrompts = [
    "Show the biggest changes in this spreadsheet.",
    "Which rows look like outliers?",
    "Summarize totals by category.",
    "Find the highest value and explain why.",
  ];

  async function submitBenchmark(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || isRunning) return;

    setError(null);
    setIsRunning(true);

    const totalStarted = performance.now();
    let uploadSeconds: number | null = null;
    let targetSpreadsheetId = spreadsheetId.trim();
    let spreadsheetFilename: string | null = null;

    try {
      if (file) {
        const formData = new FormData();
        formData.append("spreadsheet", file);
        formData.append("spreadsheetId", crypto.randomUUID());
        formData.append("preExtract", String(preExtract));

        const uploadStarted = performance.now();
        const upload = await fetchJson<SpreadsheetResponse>("/api/spreadsheets", {
          body: formData,
          method: "POST",
        });
        uploadSeconds = (performance.now() - uploadStarted) / 1000;
        targetSpreadsheetId = upload.spreadsheet.id;
        spreadsheetFilename = upload.spreadsheet.filename;
        setSpreadsheetId(targetSpreadsheetId);
      }

      const answerStarted = performance.now();
      const endpoint = targetSpreadsheetId ? `/api/spreadsheets/${targetSpreadsheetId}/agent-request` : "/api/benchmarks/query";
      const answer = await fetchJson<AgentRequestResponse>(endpoint, {
        body: JSON.stringify({ message: text }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const answerSeconds = (performance.now() - answerStarted) / 1000;
      const resolvedSpreadsheetId = answer.selectedSpreadsheet?.id ?? targetSpreadsheetId;
      const resolvedSpreadsheetFilename = answer.selectedSpreadsheet?.filename ?? spreadsheetFilename;
      if (answer.selectedSpreadsheet?.id) {
        setSpreadsheetId(answer.selectedSpreadsheet.id);
      }
      const inputTokens = tokenCount(answer.usage, ["inputTokens", "promptTokens", "prompt_tokens", "input_tokens"]);
      const outputTokens = tokenCount(answer.usage, ["outputTokens", "completionTokens", "completion_tokens", "output_tokens"]);
      const reportedTotalTokens = tokenCount(answer.usage, ["totalTokens", "total_tokens"]);
      const totalTokens = reportedTotalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);

      setRuns((current) => [
        {
          id: crypto.randomUUID(),
          answer: answer.response,
          answerSeconds,
          finishReason: answer.finishReason,
          inputTokens,
          modelName: answer.model?.model ?? null,
          modelProvider: answer.model?.provider ?? null,
          outputTokens,
          prompt: text,
          quality: null,
          requestId: answer.requestId,
          spreadsheetFilename: resolvedSpreadsheetFilename,
          spreadsheetId: resolvedSpreadsheetId,
          timestamp: new Date().toISOString(),
          totalSeconds: (performance.now() - totalStarted) / 1000,
          totalTokens,
          uploadSeconds,
        },
        ...current,
      ]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Benchmark run failed";
      setError(message);
      setRuns((current) => [
        {
          id: crypto.randomUUID(),
          answer: "",
          answerSeconds: 0,
          error: message,
          inputTokens: null,
          modelName: null,
          modelProvider: null,
          outputTokens: null,
          prompt: text,
          quality: null,
          spreadsheetFilename,
          spreadsheetId: targetSpreadsheetId || "unresolved",
          timestamp: new Date().toISOString(),
          totalSeconds: (performance.now() - totalStarted) / 1000,
          totalTokens: null,
          uploadSeconds,
        },
        ...current,
      ]);
    } finally {
      setIsRunning(false);
    }
  }

  function setQuality(runId: string, quality: number) {
    setRuns((current) => current.map((run) => (run.id === runId ? { ...run, quality } : run)));
  }

  return (
    <section className="benchmark-page analytics-page">
      <aside className="analytics-sidebar">
        <Link to="/" className="back-link">
          <ArrowLeft size={18} />
          <span>Spreadsheets</span>
        </Link>

        <section className="source-panel">
          <p className="eyebrow">Data</p>
          <h2>{file?.name ?? "Spreadsheet agent"}</h2>
          <label className="benchmark-field">
            <span>Spreadsheet file</span>
            <input
              accept=".xlsx,.xls,.csv,.tsv,.ods,.xml"
              type="file"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setError(null);
              }}
            />
          </label>
          <label className="benchmark-field">
            <span>Spreadsheet id override</span>
            <input value={spreadsheetId} onChange={(event) => setSpreadsheetId(event.target.value)} placeholder="optional uuid" />
          </label>
          <label className="mode-toggle benchmark-toggle">
            <input checked={preExtract} disabled={isRunning} type="checkbox" onChange={(event) => setPreExtract(event.target.checked)} />
            <span />
            <strong>{preExtract ? "SQL knowledge base" : "Raw file only"}</strong>
          </label>
        </section>

        <section className="source-panel">
          <p className="eyebrow">Suggested asks</p>
          <div className="prompt-chip-list">
            {suggestedPrompts.map((suggestion) => (
              <button key={suggestion} type="button" onClick={() => setPrompt(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </section>

        <Button className="clear-button" type="button" onClick={() => setRuns([])} disabled={runs.length === 0} variant="secondary">
          <Trash2 size={16} />
          <span>Clear runs</span>
        </Button>
      </aside>

      <main className="analytics-main">
        <header className="analytics-title">
          <div>
            <p className="eyebrow">Search analytics</p>
            <h1>Ask your spreadsheet anything</h1>
          </div>
          <div className="model-badge">
            <Sparkles size={16} />
            <span>{latestRun ? `${latestRun.modelProvider ?? "model"} · ${latestRun.modelName ?? "unknown"}` : "Awaiting first run"}</span>
          </div>
        </header>

        <form className="thoughtspot-search" onSubmit={submitBenchmark}>
          <Search size={22} />
          <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Ask a question about your spreadsheet..." />
          <Button
            className="primary-button"
            loading={isRunning}
            type="submit"
            variant="primary"
            disabled={isRunning || !prompt.trim()}
          >
            <Send size={18} />
            <span>{isRunning ? "Running" : "Ask"}</span>
          </Button>
        </form>

        {error ? <Banner variant="error" title="Benchmark failed" description={error} /> : null}

        <section className="metric-grid">
          <MetricCard icon={<Gauge size={18} />} label="Runs" value={String(completedRuns.length)} />
          <MetricCard icon={<Clock size={18} />} label="Avg answer speed" value={formatSeconds(averageAnswerSeconds)} />
          <MetricCard icon={<BarChart3 size={18} />} label="Avg tokens" value={formatNumber(averageTotalTokens === null ? null : Math.round(averageTotalTokens))} />
          <MetricCard icon={<Star size={18} />} label="Avg quality" value={averageQuality === null ? "n/a" : `${averageQuality.toFixed(1)}/5`} />
        </section>

        <section className="answer-canvas">
          <article className="answer-card">
            <header>
              <div>
                <p className="eyebrow">Answer</p>
                <h2>{latestRun?.prompt ?? "Run a search to generate an answer"}</h2>
              </div>
              {latestRun ? <span className="score-pill">{formatSeconds(latestRun.answerSeconds)}</span> : null}
            </header>
            <p>{latestRun?.answer ?? "The answer will appear here with model, token, speed, and quality metrics."}</p>
          </article>

          <article className="trend-card">
            <header>
              <p className="eyebrow">Token trend</p>
              <h2>Recent runs</h2>
            </header>
            <div className="token-bars">
              {completedRuns.length === 0 ? (
                <span className="trend-empty">No token data</span>
              ) : (
                completedRuns
                  .slice(0, 8)
                  .reverse()
                  .map((run) => (
                    <div className="token-bar" key={run.id}>
                      <span style={{ height: `${Math.max(8, ((run.totalTokens ?? 0) / tokenPeak) * 100)}%` }} />
                      <small>{formatNumber(run.totalTokens)}</small>
                    </div>
                  ))
              )}
            </div>
          </article>
        </section>

        <BenchmarkResults runs={runs} setQuality={setQuality} />
      </main>
    </section>
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

function BenchmarkResults({ runs, setQuality }: { runs: BenchmarkRun[]; setQuality: (runId: string, quality: number) => void }) {
  if (runs.length === 0) {
    return (
      <div className="benchmark-empty">
        <BarChart3 size={28} />
        <p>No benchmark runs yet.</p>
      </div>
    );
  }

  return (
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
              </td>
              <td>
                <strong>{formatSeconds(run.answerSeconds)}</strong>
                <span>total {formatSeconds(run.totalSeconds)}</span>
                {run.uploadSeconds !== null ? <span>upload {formatSeconds(run.uploadSeconds)}</span> : null}
              </td>
              <td>
                <strong>{formatNumber(run.totalTokens)}</strong>
                <span>in {formatNumber(run.inputTokens)} · out {formatNumber(run.outputTokens)}</span>
              </td>
              <td>
                <div className="quality-buttons" aria-label="Answer quality rating">
                  {[1, 2, 3, 4, 5].map((score) => (
                    <button className={run.quality === score ? "active" : ""} key={score} type="button" onClick={() => setQuality(run.id, score)}>
                      {score}
                    </button>
                  ))}
                </div>
              </td>
              <td>{run.error ? <span className="row-error">{run.error}</span> : run.answer}</td>
            </tr>
          ))}
        </tbody>
      </table>
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

const routeTree = rootRoute.addChildren([indexRoute, uploadRoute, agentsRoute, createAgentRoute, agentRoute, benchmarkRoute, spreadsheetRoute]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
