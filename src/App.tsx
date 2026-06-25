import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
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
  Database,
  FileSpreadsheet,
  FileText,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Send,
  Table2,
  Upload,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Spreadsheet = {
  id: string;
  filename: string;
  content_type: string;
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

function textFromParts(parts: Array<{ type: string; text?: string }>) {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
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

function cellText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

function RootLayout() {
  return (
    <main className="page-shell">
      <nav className="app-nav">
        <Link to="/" className="brand">
          <FileSpreadsheet size={22} />
          <span>XLSX Song</span>
        </Link>
        <Link to="/upload" className="nav-button">
          <Plus size={18} />
          <span>Upload</span>
        </Link>
      </nav>
      <Outlet />
    </main>
  );
}

function SpreadsheetListPage() {
  const [spreadsheets, setSpreadsheets] = useState<Spreadsheet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);

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

  return (
    <section className="content-band">
      <header className="section-header">
        <div>
          <p className="eyebrow">Spreadsheets</p>
          <h1>One agent per spreadsheet</h1>
        </div>
        <Link to="/upload" className="primary-link">
          <Upload size={18} />
          <span>Upload</span>
        </Link>
      </header>

      {isLoading ? (
        <div className="status-line">
          <Loader2 className="spin" size={18} />
          <span>Loading spreadsheets</span>
        </div>
      ) : error ? (
        <p className="error-text">{error}</p>
      ) : spreadsheets.length === 0 ? (
        <div className="empty-list">
          <FileSpreadsheet size={34} />
          <p>No spreadsheets yet.</p>
          <Link to="/upload" className="primary-link">
            <Upload size={18} />
            <span>Upload first spreadsheet</span>
          </Link>
        </div>
      ) : (
        <div className="spreadsheet-list">
          {spreadsheets.map((spreadsheet) => (
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
                  {formatBytes(spreadsheet.size_bytes)} · {spreadsheet.status ?? "ready"} · {extractionLabel(spreadsheet)} ·{" "}
                  {spreadsheet.agent_name}
                </p>
                {spreadsheet.error_message ? <p className="row-error">{spreadsheet.error_message}</p> : null}
              </div>
              {spreadsheet.status === "failed" ? (
                <button
                  className="retry-button"
                  disabled={retryingId === spreadsheet.id}
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void retryExtraction(spreadsheet.id);
                  }}
                >
                  {retryingId === spreadsheet.id ? <Loader2 className="spin" size={16} /> : null}
                  <span>{retryingId === spreadsheet.id ? "Retrying" : "Retry extraction"}</span>
                </button>
              ) : null}
            </Link>
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
  const [preExtract, setPreExtract] = useState(true);
  const [uploadAgentName, setUploadAgentName] = useState<string | null>(null);
  const [uploadTraces, setUploadTraces] = useState<AgentTrace[]>([]);
  useAgent({
    agent: "HackathonAgent",
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

  function selectFile(nextFile: File | null) {
    setFile(nextFile);
    setError(null);
    setUploadTraces([]);
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
    setError(null);
    setIsUploading(true);
    setUploadAgentName(agentName);
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

        {error ? <p className="error-text">{error}</p> : null}

        <button className="primary-button" type="submit" disabled={!file || isUploading}>
          {isUploading ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
          <span>{isUploading ? "Uploading" : "Create agent"}</span>
        </button>

        {(isUploading || uploadTraces.length > 0) && (
          <div className="upload-steps">
            <header>
              <p className="eyebrow">{preExtract ? "Analysis" : "Upload"}</p>
              <h2>{preExtract ? "Preparing spreadsheet agent" : "Storing spreadsheet file"}</h2>
            </header>
            <ol className="trace-list">
              {uploadTraces.map((trace) => {
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
                      <p>{trace.span_type}</p>
                      {detail ? <pre>{detail}</pre> : null}
                    </article>
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
        <p className="error-text">{error}</p>
      </section>
    );
  }

  if (!spreadsheet) {
    return (
      <section className="content-band">
        <div className="status-line">
          <Loader2 className="spin" size={18} />
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
    agent: "HackathonAgent",
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

  const visibleMessages = useMemo(
    () => messages.filter((message) => textFromParts(message.parts).trim().length > 0),
    [messages],
  );

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
          <button className="retry-button header-retry" disabled={isRetryingExtraction} type="button" onClick={() => void retryExtraction()}>
            {isRetryingExtraction ? <Loader2 className="spin" size={16} /> : null}
            <span>{isRetryingExtraction ? "Retrying extraction" : "Retry extraction"}</span>
          </button>
        ) : null}
        <nav className="view-tabs" aria-label="Spreadsheet agent views">
          <button className={activeView === "chat" ? "active" : ""} type="button" onClick={() => setActiveView("chat")}>
            <FileSpreadsheet size={16} />
            <span>Chat</span>
          </button>
          <button className={activeView === "sqlite" ? "active" : ""} type="button" onClick={() => setActiveView("sqlite")}>
            <Database size={16} />
            <span>SQLite</span>
          </button>
          <button className={activeView === "raw" ? "active" : ""} type="button" onClick={() => setActiveView("raw")}>
            <FileText size={16} />
            <span>Raw</span>
          </button>
        </nav>
      </header>

      <div className={`chat-main ${isTraceCollapsed ? "trace-collapsed" : ""}`}>
        {activeView === "chat" ? (
          <div className="messages">
            {visibleMessages.length === 0 ? (
              <div className="empty-state">
                <FileSpreadsheet size={28} />
                <p>
                  {spreadsheet.pre_extract === 0
                    ? "This spreadsheet is available as a raw file in the sandbox."
                    : "This spreadsheet has a pre-extracted SQLite database."}
                </p>
              </div>
            ) : (
              visibleMessages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <span>{message.role}</span>
                  <p>{textFromParts(message.parts)}</p>
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

        <aside className={`trace-panel ${isTraceCollapsed ? "is-collapsed" : ""}`}>
          <header>
            <div className="trace-heading">
              <p className="eyebrow">Trace</p>
              <h2>Agent steps</h2>
            </div>
            <button
              aria-label={isTraceCollapsed ? "Expand trace panel" : "Collapse trace panel"}
              className="trace-toggle"
              onClick={() => setIsTraceCollapsed((value) => !value)}
              title={isTraceCollapsed ? "Expand trace panel" : "Collapse trace panel"}
              type="button"
            >
              {isTraceCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
            </button>
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

      <form className="composer" onSubmit={submitMessage}>
        <input
          aria-label="Message"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask this spreadsheet agent..."
        />
        <button className="icon-button" type="submit" disabled={isBusy || !input.trim()}>
          {isBusy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
        </button>
      </form>
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
          <Loader2 className="spin" size={18} />
          <span>Loading extracted tables</span>
        </div>
      ) : null}

      {analysisTables && analysisTables.tables.length === 0 ? (
        <div className="viewer-empty">
          <Database size={24} />
          <p>No extracted SQLite tables found for this spreadsheet.</p>
        </div>
      ) : null}

      {analysisTables && analysisTables.tables.length > 0 ? (
        <div className="viewer-grid">
          <aside className="table-picker">
            {analysisTables.tables.map((table) => (
              <button
                className={selectedTable === table.table_name ? "active" : ""}
                key={table.table_name}
                type="button"
                onClick={() => setSelectedTable(table.table_name)}
              >
                <Table2 size={16} />
                <span>{table.table_name}</span>
                <small>{table.row_count} rows</small>
              </button>
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
          <Loader2 className="spin" size={18} />
          <span>Loading raw preview</span>
        </div>
      ) : null}

      {rawPreview && rawPreview.preview.sheets.length > 1 ? (
        <nav className="sheet-tabs" aria-label="Raw spreadsheet sheets">
          {rawPreview.preview.sheets.map((nextSheet, index) => (
            <button className={index === activeSheet ? "active" : ""} key={nextSheet.name} type="button" onClick={() => setActiveSheet(index)}>
              {nextSheet.name}
            </button>
          ))}
        </nav>
      ) : null}

      {rawPreview && !sheet ? (
        <div className="viewer-empty">
          <FileText size={24} />
          <p>No previewable rows were found in the raw spreadsheet.</p>
        </div>
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
      <div className="viewer-empty">
        <Table2 size={24} />
        <p>No rows to preview.</p>
      </div>
    );
  }

  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column) => (
                <td key={column}>{cellText(row[column])}</td>
              ))}
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

const spreadsheetRoute = createRoute({
  component: SpreadsheetChatPage,
  getParentRoute: () => rootRoute,
  path: "/spreadsheets/$spreadsheetId",
});

const routeTree = rootRoute.addChildren([indexRoute, uploadRoute, spreadsheetRoute]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
