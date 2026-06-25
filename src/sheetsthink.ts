import { getSandbox } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import { generateText, stepCountIs, tool } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
  CODEMODE_INSPECTION_SCRIPT,
  arrayBufferToBase64,
  RAW_PREVIEW_SCRIPT,
  configuredModelEntries,
  extractionTableSummary,
  getSpreadsheetRow,
  json,
  listSpreadsheetRevisionRows,
  modelConfig,
  normalizeCodemodeExtraction,
  parseJsonText,
  parseStringArray,
  profileSummary,
  providerModel,
  runPython,
  safeFilename,
  safeTraceDetail,
  spreadsheetIdFromAgentName,
  stripCodeFence,
  traceDetail,
  type AgentRequestPayload,
  type AgentTraceEvent,
  type CodemodeExtraction,
  type Env,
  type TraceInput,
} from "./http";

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

