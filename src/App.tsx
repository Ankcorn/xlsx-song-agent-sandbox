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
import { ArrowLeft, FileSpreadsheet, Loader2, Plus, Send, Upload } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Spreadsheet = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  agent_name: string;
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

  useEffect(() => {
    fetchJson<SpreadsheetListResponse>("/api/spreadsheets")
      .then((data) => setSpreadsheets(data.spreadsheets))
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setIsLoading(false));
  }, []);

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
              className="spreadsheet-row"
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
              </div>
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

  function selectFile(nextFile: File | null) {
    setFile(nextFile);
    setError(null);
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

    const formData = new FormData();
    formData.append("spreadsheet", file);
    setError(null);
    setIsUploading(true);

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

        {error ? <p className="error-text">{error}</p> : null}

        <button className="primary-button" type="submit" disabled={!file || isUploading}>
          {isUploading ? <Loader2 className="spin" size={18} /> : <Upload size={18} />}
          <span>{isUploading ? "Uploading" : "Create agent"}</span>
        </button>
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

  return <ChatSurface input={input} setInput={setInput} spreadsheet={spreadsheet} />;
}

function ChatSurface({
  input,
  setInput,
  spreadsheet,
}: {
  input: string;
  setInput: (value: string) => void;
  spreadsheet: Spreadsheet;
}) {
  const agent = useAgent({ agent: "HackathonAgent", name: spreadsheet.agent_name });
  const { messages, sendMessage, status } = useAgentChat({ agent });
  const [traces, setTraces] = useState<AgentTrace[]>([]);
  const isBusy = status === "submitted" || status === "streaming";

  const visibleMessages = useMemo(
    () => messages.filter((message) => textFromParts(message.parts).trim().length > 0),
    [messages],
  );

  useEffect(() => {
    let isMounted = true;
    let timeout: number | undefined;

    async function loadTraces() {
      try {
        const data = await fetchJson<AgentTraceResponse>(`/api/spreadsheets/${spreadsheet.id}/traces`);
        if (isMounted) setTraces(data.traces);
      } finally {
        if (isMounted) {
          timeout = window.setTimeout(loadTraces, isBusy ? 900 : 3000);
        }
      }
    }

    loadTraces();

    return () => {
      isMounted = false;
      if (timeout) window.clearTimeout(timeout);
    };
  }, [isBusy, spreadsheet.id]);

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;
    sendMessage({ text });
    setInput("");
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
            {formatBytes(spreadsheet.size_bytes)} · {spreadsheet.content_type || "spreadsheet"}
          </p>
        </div>
      </header>

      <div className="chat-main">
        <div className="messages">
          {visibleMessages.length === 0 ? (
            <div className="empty-state">
              <FileSpreadsheet size={28} />
              <p>This spreadsheet has its own retained agent.</p>
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

        <aside className="trace-panel">
          <header>
            <p className="eyebrow">Trace</p>
            <h2>Agent steps</h2>
          </header>
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
