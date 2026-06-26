import { getSandbox } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import { generateText, stepCountIs, tool } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
  json,
  jsonRenderResponseInstructions,
  generatedTextFromResult,
  modelEntriesForRequest,
  modelConfig,
  parseJsonText,
  parseStringArray,
  providerModel,
  requestedModelEntry,
  safeTraceDetail,
  type AgentChatMessage,
  type AgentInitializationPayload,
  type AgentRequestPayload,
  type AgentTraceEvent,
  type Env,
  type ModelEntry,
  type TraceInput,
} from "./http";

export class AgentThink extends Think<Env> {
  private agentSchemaReady = false;
  private chatSchemaReady = false;
  private traceSchemaReady = false;
  private turnStartTimes = new Map<string, number>();

  getModel(selectedModel?: ModelEntry) {
    const entries = modelEntriesForRequest(this.env, selectedModel);
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
      "When the user asks for cleaned, normalized, consolidated, or REST-ready data, use create_clean_table and generate a small JavaScript Dynamic Worker transform.",
      "The generated Dynamic Worker must export default.fetch(request), read JSON from request.json(), and return Response.json({ name, description, grain, columns, rows, metadata }).",
      "The request JSON contains { request: { name, description }, database, tables }, where tables maps table names to row arrays.",
      "Generated clean table workers must return one flat JSON table with stable snake_case columns and source_table, source_row, source_ref provenance.",
      "After creating a clean table, tell the user the exact table name and row count.",
      "When citing values, include source spreadsheet/table/source_ref/source_row where possible.",
      "Keep answers concise, concrete, and useful.",
      jsonRenderResponseInstructions(),
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
      create_clean_table: tool({
        description:
          "Create a cleaned, REST-friendly private SQLite table by running generated JavaScript in an isolated Dynamic Worker against this Agent's table snapshot.",
        inputSchema: z.object({
          description: z.string().min(1).describe("Plain-language purpose and grain for the cleaned table."),
          javascript: z.string().min(1).describe("A complete JavaScript Worker module exporting default.fetch(request), returning the clean table JSON."),
          name: z.string().min(1).describe("Stable name for the cleaned table, e.g. child_development_outcomes."),
        }),
        execute: async ({ description, javascript, name }) => this.createCleanAgentTable(name, description, javascript),
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
    if (url.pathname.endsWith("/api-feed") && request.method === "GET") return json(this.getAgentApiFeed(url.searchParams.get("agentId")));
    if (url.pathname.endsWith("/api-feed-table") && request.method === "GET") {
      const tableName = url.searchParams.get("table");
      if (!tableName) return json({ error: "Missing table query parameter." }, { status: 400 });
      return this.getAgentApiFeedTable(tableName, url.searchParams);
    }
    if (url.pathname.endsWith("/report") && request.method === "GET") return json({ report: this.getAgentReport() });
    if (url.pathname.endsWith("/report") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { prompt?: unknown };
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      return json({ report: await this.generateAgentReport(prompt) });
    }
    if (url.pathname.endsWith("/song") && request.method === "GET") return json({ song: this.getAgentSong() });
    if (url.pathname.endsWith("/song") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { language?: unknown; lengthMs?: unknown; prompt?: unknown };
      const language = typeof body.language === "string" ? body.language.trim() : "";
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const lengthMs = typeof body.lengthMs === "number" ? body.lengthMs : undefined;
      return json({ song: await this.generateAgentSong(prompt, lengthMs, language) });
    }
    if (url.pathname.endsWith("/song/audio") && request.method === "GET") return this.getAgentSongAudio();
    if (url.pathname.endsWith("/song/cover") && request.method === "GET") return this.getAgentSongCover();
    if (url.pathname.endsWith("/agent-table") && request.method === "GET") {
      const tableName = url.searchParams.get("table");
      if (!tableName) return json({ error: "Missing table query parameter." }, { status: 400 });
      if (url.searchParams.get("public") === "1") {
        const result = this.getPublicAgentDatabaseTable(
          tableName,
          url.searchParams.get("limit"),
          url.searchParams.get("offset"),
          url.searchParams.get("agentId"),
        );
        return "error" in result ? json(result, { status: 404 }) : json(result);
      }
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
    if (url.pathname.endsWith("/chat-history") && request.method === "GET") {
      return json({ messages: this.listChatMessages() });
    }
    if (url.pathname.endsWith("/chat-history") && request.method === "DELETE") {
      this.clearChatMessages();
      return json({ ok: true });
    }
    if (url.pathname.endsWith("/api-request") && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as AgentRequestPayload;
      if (typeof body.message !== "string" || !body.message.trim()) {
        return json({ error: "Send JSON with a non-empty 'message' string." }, { status: 400 });
      }
      let selectedModel: ModelEntry | undefined;
      try {
        selectedModel = requestedModelEntry(this.env, body);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Invalid model." }, { status: 400 });
      }
      const requestId = crypto.randomUUID();
      const startedAt = Date.now();
      const model = modelConfig(this.env, selectedModel);
      const previousMessages = this.listChatMessages(8);
      this.recordChatMessage("user", body.message, requestId);
      this.recordTrace({ detail: { message: body.message, model }, requestId, spanType: "api", status: "running", title: "API request received" });
      try {
        const result = await generateText({
          model: this.getModel(selectedModel),
          prompt: this.promptWithChatHistory(previousMessages, body.message),
          stopWhen: stepCountIs(8),
          system: this.getSystemPrompt(),
          temperature: 0.2,
          tools: this.getTools(),
        });
        const responseText =
          generatedTextFromResult(result) ||
          "The agent completed the request but did not return a visible answer. Please retry or ask for a shorter answer.";
        this.recordTrace({
          detail: { emptyResponse: !generatedTextFromResult(result), finishReason: result.finishReason, usage: result.usage },
          durationMs: Date.now() - startedAt,
          requestId,
          spanType: "api",
          status: "done",
          title: "API request complete",
        });
        this.recordChatMessage("assistant", responseText, requestId);
        return json({ agentName: this.name, finishReason: result.finishReason, model, requestId, response: responseText, usage: result.usage });
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

  private ensureChatSchema() {
    if (this.chatSchemaReady) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_chat_messages (
        id TEXT PRIMARY KEY,
        request_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `;
    this.sql`CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_created_at ON agent_chat_messages (created_at ASC)`;
    this.chatSchemaReady = true;
  }

  private listChatMessages(limit = 80): AgentChatMessage[] {
    this.ensureChatSchema();
    return this.sql<AgentChatMessage>`
      SELECT id, role, text, created_at
      FROM (
        SELECT id, role, text, created_at
        FROM agent_chat_messages
        ORDER BY created_at DESC
        LIMIT ${limit}
      )
      ORDER BY created_at ASC
    `;
  }

  private recordChatMessage(role: AgentChatMessage["role"], text: string, requestId: string) {
    this.ensureChatSchema();
    this.sql`
      INSERT INTO agent_chat_messages (id, request_id, role, text)
      VALUES (${crypto.randomUUID()}, ${requestId}, ${role}, ${text})
    `;
  }

  private clearChatMessages() {
    this.ensureChatSchema();
    this.sql`DELETE FROM agent_chat_messages`;
  }

  private promptWithChatHistory(messages: AgentChatMessage[], message: string) {
    if (messages.length === 0) return message;
    const history = messages.map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`).join("\n\n");
    return `Recent conversation:\n${history}\n\nUSER: ${message}`;
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
        metadata_json TEXT,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_reports (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        title TEXT,
        generated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS agent_songs (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        title TEXT,
        language TEXT NOT NULL DEFAULT 'English',
        music_prompt TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        audio_r2_key TEXT NOT NULL,
        cover_image_r2_key TEXT,
        cover_image_content_type TEXT,
        cover_prompt TEXT,
        content_type TEXT NOT NULL,
        model_id TEXT NOT NULL,
        output_format TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    try {
      this.ctx.storage.sql.exec("ALTER TABLE agent_songs ADD COLUMN language TEXT NOT NULL DEFAULT 'English'");
    } catch (error) {
      if (!(error instanceof Error ? error.message : String(error)).toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
    for (const column of ["cover_image_r2_key TEXT", "cover_image_content_type TEXT", "cover_prompt TEXT"]) {
      try {
        this.ctx.storage.sql.exec(`ALTER TABLE agent_songs ADD COLUMN ${column}`);
      } catch (error) {
        if (!(error instanceof Error ? error.message : String(error)).toLowerCase().includes("duplicate column")) {
          throw error;
        }
      }
    }
    try {
      this.ctx.storage.sql.exec("ALTER TABLE agent_table_mappings ADD COLUMN metadata_json TEXT");
    } catch (error) {
      if (!(error instanceof Error ? error.message : String(error)).toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
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

  private getAgentReport() {
    this.ensureAgentSchema();
    const row = this.sql<{ generated_at: string; id: string; prompt: string; spec_json: string; title: string | null; updated_at: string }>`
      SELECT id, prompt, spec_json, title, generated_at, updated_at
      FROM agent_reports
      WHERE id = 'current'
      LIMIT 1
    `[0];
    if (!row) return null;
    const latestDataUpdatedAt = this.latestAgentDataUpdatedAt();
    return {
      generatedAt: row.generated_at,
      id: row.id,
      isStale: latestDataUpdatedAt ? new Date(latestDataUpdatedAt).getTime() > new Date(row.generated_at).getTime() : false,
      latestDataUpdatedAt,
      prompt: row.prompt,
      spec: this.parseJsonObject(row.spec_json) ?? row.spec_json,
      title: row.title,
      updatedAt: row.updated_at,
    };
  }

  private getAgentSong() {
    this.ensureAgentSchema();
    const row = this.sql<{
      audio_r2_key: string;
      content_type: string;
      cover_image_content_type: string | null;
      cover_image_r2_key: string | null;
      cover_prompt: string | null;
      facts_json: string;
      generated_at: string;
      id: string;
      language: string;
      model_id: string;
      music_prompt: string;
      output_format: string;
      prompt: string;
      title: string | null;
      updated_at: string;
    }>`
      SELECT id, prompt, title, language, music_prompt, facts_json, audio_r2_key, cover_image_r2_key, cover_image_content_type, cover_prompt, content_type, model_id, output_format, generated_at, updated_at
      FROM agent_songs
      WHERE id = 'current'
      LIMIT 1
    `[0];
    if (!row) return null;
    const latestDataUpdatedAt = this.latestAgentDataUpdatedAt();
    return {
      audioUrl: `/api/agents/${this.agentIdFromName()}/song/audio`,
      coverArtUrl: row.cover_image_r2_key ? `/api/agents/${this.agentIdFromName()}/song/cover` : null,
      coverPrompt: row.cover_prompt,
      facts: this.parseStringList(row.facts_json),
      generatedAt: row.generated_at,
      id: row.id,
      isStale: latestDataUpdatedAt ? new Date(latestDataUpdatedAt).getTime() > new Date(row.generated_at).getTime() : false,
      language: row.language,
      latestDataUpdatedAt,
      modelId: row.model_id,
      musicPrompt: row.music_prompt,
      outputFormat: row.output_format,
      prompt: row.prompt,
      title: row.title,
      updatedAt: row.updated_at,
    };
  }

  private async getAgentSongAudio() {
    this.ensureAgentSchema();
    const row = this.sql<{ audio_r2_key: string; content_type: string; title: string | null }>`
      SELECT audio_r2_key, content_type, title
      FROM agent_songs
      WHERE id = 'current'
      LIMIT 1
    `[0];
    if (!row) return json({ error: "No song generated yet." }, { status: 404 });
    const object = await this.env.SPREADSHEETS.get(row.audio_r2_key);
    if (!object) return json({ error: "Generated song audio was not found." }, { status: 404 });
    const headers = new Headers();
    headers.set("Content-Type", row.content_type || object.httpMetadata?.contentType || "audio/mpeg");
    headers.set("Content-Length", String(object.size));
    headers.set("Content-Disposition", `inline; filename="${this.safeSongFilename(row.title)}.mp3"`);
    return new Response(object.body, { headers });
  }

  private async getAgentSongCover() {
    this.ensureAgentSchema();
    const row = this.sql<{ cover_image_content_type: string | null; cover_image_r2_key: string | null; title: string | null }>`
      SELECT cover_image_r2_key, cover_image_content_type, title
      FROM agent_songs
      WHERE id = 'current'
      LIMIT 1
    `[0];
    if (!row?.cover_image_r2_key) return json({ error: "No song cover generated yet." }, { status: 404 });
    const object = await this.env.SPREADSHEETS.get(row.cover_image_r2_key);
    if (!object) return json({ error: "Generated song cover was not found." }, { status: 404 });
    const headers = new Headers();
    headers.set("Content-Type", row.cover_image_content_type || object.httpMetadata?.contentType || "image/jpeg");
    headers.set("Content-Length", String(object.size));
    headers.set("Content-Disposition", `inline; filename="${this.safeSongFilename(row.title)}-cover.jpg"`);
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    return new Response(object.body, { headers });
  }

  private latestAgentDataUpdatedAt() {
    this.ensureAgentSchema();
    const rows = [
      ...this.sql<{ updated_at: string }>`SELECT updated_at FROM agent_metadata`,
      ...this.sql<{ updated_at: string }>`SELECT updated_at FROM agent_sources`,
      ...this.sql<{ updated_at: string }>`SELECT updated_at FROM agent_table_mappings`,
    ];
    return rows
      .map((row) => row.updated_at)
      .filter(Boolean)
      .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;
  }

  private async generateAgentReport(prompt: string) {
    this.ensureAgentSchema();
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const finalPrompt =
      prompt ||
      "Generate an executive report for this agent's current attached datasets. Summarize the most important facts, include key metrics, comparisons, caveats, and source notes. Make it useful as a standalone shared report.";
    this.recordTrace({
      detail: { prompt: finalPrompt },
      requestId,
      spanType: "report",
      status: "running",
      title: "Generating agent report",
    });

    try {
      const snapshot = this.exportAgentSnapshot(250);
      const result = await generateText({
        model: this.getModel(),
        prompt: [
          finalPrompt,
          "",
          "Use the agent database snapshot below. Build a standalone report, not a chat reply.",
          "Return ONLY the json-render spec JSON object.",
          "",
          JSON.stringify(snapshot),
        ].join("\n"),
        system: [
          "You are generating a durable report for a multi-spreadsheet data agent.",
          "The report will be hosted at the agent's /report page and should stand alone without chat context.",
          "Use source notes, caveats, and citations where possible.",
          "Prefer concise sections with clear headings, metrics, charts, and small tables.",
          jsonRenderResponseInstructions(),
        ].join("\n"),
        temperature: 0.15,
      });
      const text = generatedTextFromResult(result);
      const spec = parseJsonText(text);
      const title = this.reportTitleFromSpec(spec) ?? "Agent report";
      const now = new Date().toISOString();
      this.sql`
        INSERT INTO agent_reports (id, prompt, spec_json, title, generated_at, updated_at)
        VALUES ('current', ${finalPrompt}, ${JSON.stringify(spec)}, ${title}, ${now}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          prompt = excluded.prompt,
          spec_json = excluded.spec_json,
          title = excluded.title,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
      `;
      this.recordTrace({
        detail: { title, usage: result.usage },
        durationMs: Date.now() - startedAt,
        requestId,
        spanType: "report",
        status: "done",
        title: "Agent report generated",
      });
      return this.getAgentReport();
    } catch (error) {
      this.recordTrace({
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        requestId,
        spanType: "report",
        status: "error",
        title: "Agent report failed",
      });
      throw error;
    }
  }

  private async generateAgentSong(prompt: string, lengthMs?: number, requestedLanguage?: string) {
    this.ensureAgentSchema();
    if (!this.env.ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY is not configured.");

    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const finalPrompt =
      prompt ||
      "Create a catchy, data-driven song from this agent's current datasets. Pull out memorable facts, trends, and caveats from the SQL snapshot and turn them into lyrics.";
    const modelId = this.env.ELEVENLABS_MUSIC_MODEL_ID || "music_v2";
    const outputFormat = this.env.ELEVENLABS_OUTPUT_FORMAT || "mp3_44100_128";
    const musicLengthMs = Math.max(10_000, Math.min(120_000, lengthMs ?? 45_000));
    const language = requestedLanguage && requestedLanguage !== "Custom / prompt decides" ? requestedLanguage : "Custom / prompt decides";
    const languageInstruction =
      language === "Custom / prompt decides"
        ? "Use the language requested in the user's custom prompt. If no language is requested, use English."
        : `Generate the song primarily in ${language}. Keep proper nouns, dataset names, and key numeric facts accurate.`;

    this.recordTrace({
      detail: { language, lengthMs: musicLengthMs, prompt: finalPrompt },
      requestId,
      spanType: "song",
      status: "running",
      title: "Generating agent song",
    });

    try {
      const snapshot = this.exportAgentSnapshot(250);
      const briefResult = await generateText({
        model: this.getModel(),
        prompt: [
          finalPrompt,
          "",
          "Use the SQL-like agent database snapshot below to extract concrete facts and write a compact ElevenLabs music prompt.",
          "Return ONLY JSON with this shape: {\"title\":\"...\",\"facts\":[\"...\"],\"musicPrompt\":\"...\"}.",
          "The musicPrompt should include genre, mood, structure, vocal style, and lyrics or lyric guidance. Keep it under 3000 characters.",
          languageInstruction,
          "Use real facts from the snapshot; do not invent statistics.",
          "",
          JSON.stringify(snapshot),
        ].join("\n"),
        system: [
          "You create music briefs from data-agent SQLite snapshots.",
          "Pull out requested facts, trends, rankings, dates, and caveats, then transform them into a polished song-generation prompt.",
          "Return strict JSON only.",
        ].join("\n"),
        temperature: 0.2,
      });
      const brief = this.parseSongBrief(generatedTextFromResult(briefResult), finalPrompt);
      const musicUrl = new URL("https://api.elevenlabs.io/v1/music/stream");
      musicUrl.searchParams.set("output_format", outputFormat);
      const coverPrompt = this.songCoverPrompt(brief, language);
      const coverPromise = this.generateSongCoverArt(coverPrompt, requestId).catch((error) => {
        this.recordTrace({
          detail: error instanceof Error ? error.message : String(error),
          requestId,
          spanType: "song",
          status: "error",
          title: "Song cover generation failed",
        });
        return null;
      });
      const musicPromise = fetch(musicUrl, {
        body: JSON.stringify({
          model_id: modelId,
          music_length_ms: musicLengthMs,
          prompt: brief.musicPrompt,
        }),
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": this.env.ELEVENLABS_API_KEY,
        },
        method: "POST",
      });
      const [musicResponse, cover] = await Promise.all([musicPromise, coverPromise]);

      if (!musicResponse.ok) {
        throw new Error((await musicResponse.text().catch(() => "")) || `ElevenLabs music request failed (${musicResponse.status}).`);
      }

      const audio = await musicResponse.arrayBuffer();
      const contentType = musicResponse.headers.get("content-type") || "audio/mpeg";
      const now = new Date().toISOString();
      const audioR2Key = `agent-songs/${this.name}/current-${Date.now()}.mp3`;
      await this.env.SPREADSHEETS.put(audioR2Key, audio, {
        httpMetadata: { contentType },
        customMetadata: {
          agentName: this.name,
          language,
          modelId,
          title: brief.title,
        },
      });

      this.sql`
        INSERT INTO agent_songs (id, prompt, title, language, music_prompt, facts_json, audio_r2_key, cover_image_r2_key, cover_image_content_type, cover_prompt, content_type, model_id, output_format, generated_at, updated_at)
        VALUES ('current', ${finalPrompt}, ${brief.title}, ${language}, ${brief.musicPrompt}, ${JSON.stringify(brief.facts)}, ${audioR2Key}, ${cover?.r2Key ?? null}, ${cover?.contentType ?? null}, ${coverPrompt}, ${contentType}, ${modelId}, ${outputFormat}, ${now}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          prompt = excluded.prompt,
          title = excluded.title,
          language = excluded.language,
          music_prompt = excluded.music_prompt,
          facts_json = excluded.facts_json,
          audio_r2_key = excluded.audio_r2_key,
          cover_image_r2_key = excluded.cover_image_r2_key,
          cover_image_content_type = excluded.cover_image_content_type,
          cover_prompt = excluded.cover_prompt,
          content_type = excluded.content_type,
          model_id = excluded.model_id,
          output_format = excluded.output_format,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
      `;

      this.recordTrace({
        detail: { byteLength: audio.byteLength, coverArt: Boolean(cover), facts: brief.facts, title: brief.title, usage: briefResult.usage },
        durationMs: Date.now() - startedAt,
        requestId,
        spanType: "song",
        status: "done",
        title: "Agent song generated",
      });
      return this.getAgentSong();
    } catch (error) {
      this.recordTrace({
        detail: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        requestId,
        spanType: "song",
        status: "error",
        title: "Agent song failed",
      });
      throw error;
    }
  }

  private reportTitleFromSpec(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const elements = (value as { elements?: unknown }).elements;
    if (!elements || typeof elements !== "object") return null;
    for (const element of Object.values(elements as Record<string, unknown>)) {
      if (!element || typeof element !== "object") continue;
      const record = element as { props?: Record<string, unknown>; type?: unknown };
      if (record.type === "Heading" && typeof record.props?.text === "string" && record.props.text.trim()) {
        return record.props.text.trim().slice(0, 160);
      }
    }
    return null;
  }

  private parseSongBrief(text: string, fallbackPrompt: string) {
    const parsed = parseJsonText(text) as unknown;
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const facts = Array.isArray(record.facts)
      ? record.facts.map((fact) => String(fact).trim()).filter(Boolean).slice(0, 8)
      : [];
    const title = typeof record.title === "string" && record.title.trim() ? record.title.trim().slice(0, 120) : "Data song";
    const musicPrompt =
      typeof record.musicPrompt === "string" && record.musicPrompt.trim()
        ? record.musicPrompt.trim().slice(0, 4000)
        : `${fallbackPrompt}\n\nWrite a concise song using the agent's data facts.`;
    return { facts, musicPrompt, title };
  }

  private songCoverPrompt(brief: { facts: string[]; musicPrompt: string; title: string }, language: string) {
    const facts = brief.facts.slice(0, 4).join("; ");
    return [
      `Square album cover art for a data song titled "${brief.title}".`,
      "Clean modern editorial illustration, neutral shadcn-inspired palette with one vivid accent, crisp composition, no UI chrome, no readable text, no logos.",
      "Visual metaphor: spreadsheets, charts, flowing music waves, and open-data patterns blending into a polished record sleeve.",
      facts ? `Data cues to inspire the imagery: ${facts}.` : "",
      language && language !== "Custom / prompt decides" ? `Subtle cultural/language mood: ${language}.` : "",
      `Song mood brief: ${brief.musicPrompt.slice(0, 800)}`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  private async generateSongCoverArt(prompt: string, requestId: string) {
    const startedAt = Date.now();
    this.recordTrace({
      detail: { model: "@cf/black-forest-labs/flux-2-klein-9b", prompt },
      requestId,
      spanType: "song",
      status: "running",
      title: "Generating song cover art",
    });
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", "1024");
    form.append("height", "1024");
    const formResponse = new Response(form);
    const formStream = formResponse.body;
    const formContentType = formResponse.headers.get("content-type");
    if (!formStream || !formContentType) throw new Error("Could not serialize cover art multipart request.");

    const response = await (this.env.AI as unknown as { run: (model: string, input: unknown) => Promise<{ image?: string }> }).run("@cf/black-forest-labs/flux-2-klein-9b", {
      multipart: {
        body: formStream,
        contentType: formContentType,
      },
    });
    if (!response.image) throw new Error("Flux did not return image data.");

    const bytes = this.base64ToUint8Array(response.image);
    const contentType = "image/jpeg";
    const r2Key = `agent-songs/${this.name}/cover-${Date.now()}.jpg`;
    await this.env.SPREADSHEETS.put(r2Key, bytes, {
      httpMetadata: { contentType },
      customMetadata: {
        agentName: this.name,
        modelId: "@cf/black-forest-labs/flux-2-klein-9b",
      },
    });
    this.recordTrace({
      detail: { byteLength: bytes.byteLength, model: "@cf/black-forest-labs/flux-2-klein-9b", r2Key },
      durationMs: Date.now() - startedAt,
      requestId,
      spanType: "song",
      status: "done",
      title: "Song cover art generated",
    });
    return { contentType, r2Key };
  }

  private base64ToUint8Array(value: string) {
    const binary = atob(value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  private parseStringList(text: string | null) {
    if (!text) return [];
    try {
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed.map((value) => String(value)).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  private agentIdFromName() {
    return this.name.startsWith("agent-") ? this.name.slice("agent-".length) : this.name;
  }

  private safeSongFilename(title: string | null) {
    return (title || "agent-song").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent-song";
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
    const table = this.sql<{ columns_json: string; metadata_json: string | null; row_count: number; source_name: string | null; table_name: string }>`
      SELECT table_name, COALESCE(source_name, table_kind) AS source_name, columns_json, row_count, metadata_json
      FROM agent_table_mappings
      WHERE table_name = ${tableName}
      LIMIT 1
    `[0];
    if (!table) return { columns: [], rows: [], table: null };
    const columns = parseStringArray(table.columns_json);
    const rows = [...this.ctx.storage.sql.exec(`SELECT * FROM ${this.quoteIdentifier(tableName)} LIMIT 200`)];
    return { columns, rows, table: { ...table, columns, metadata: this.parseJsonObject(table.metadata_json) } };
  }

  private getPublicAgentDatabaseTable(tableName: string, limitParam?: string | null, offsetParam?: string | null, agentId?: string | null) {
    this.ensureAgentSchema();
    const table = this.sql<{ columns_json: string; metadata_json: string | null; row_count: number; source_name: string | null; table_name: string }>`
      SELECT table_name, COALESCE(source_name, table_kind) AS source_name, columns_json, row_count, metadata_json
      FROM agent_table_mappings
      WHERE table_name = ${tableName}
      LIMIT 1
    `[0];
    if (!table) return { error: "Table not found." };
    const limit = this.clampInteger(limitParam, 100, 1, 500);
    const offset = this.clampInteger(offsetParam, 0, 0, 1_000_000);
    const rows = [...this.ctx.storage.sql.exec(`SELECT * FROM ${this.quoteIdentifier(tableName)} LIMIT ? OFFSET ?`, limit, offset)];
    return {
      agentId,
      columns: parseStringArray(table.columns_json),
      limit,
      metadata: this.parseJsonObject(table.metadata_json),
      offset,
      rowCount: table.row_count,
      rows,
      sourceName: table.source_name,
      table: table.table_name,
    };
  }

  private getAgentApiFeed(agentId?: string | null) {
    this.ensureAgentSchema();
    const metadata = this.sql<{ description: string; id: string; name: string; updated_at: string }>`SELECT id, name, description, updated_at FROM agent_metadata LIMIT 1`[0] ?? null;
    const tables = this.sql<{
      category: string | null;
      columns_json: string;
      metadata_json: string | null;
      row_count: number;
      source_name: string | null;
      table_kind: string;
      table_name: string;
      updated_at: string;
    }>`
      SELECT table_name, COALESCE(source_name, table_kind) AS source_name, category, columns_json, row_count, table_kind, metadata_json, updated_at
      FROM agent_table_mappings
      ORDER BY table_kind, table_name
    `;
    const resolvedAgentId = agentId || this.agentIdFromName();
    return {
      agent: metadata,
      generatedAt: new Date().toISOString(),
      tables: tables.map((table) => {
        const rows = this.cleanedRowsForTable(table.table_name, 5, 0);
        const columns = parseStringArray(table.columns_json);
        return {
          apiUrl: `/api/agents/${resolvedAgentId}/feed/${encodeURIComponent(table.table_name)}`,
          category: table.category,
          columns: columns.map((column) => ({ name: column, type: this.inferApiColumnType(rows, column) })),
          csvUrl: `/api/agents/${resolvedAgentId}/feed/${encodeURIComponent(table.table_name)}?format=csv`,
          metadata: this.parseJsonObject(table.metadata_json),
          publicUrl: `/public/agents/${resolvedAgentId}/feed/${encodeURIComponent(table.table_name)}`,
          rowCount: table.row_count,
          sampleRows: rows,
          sourceName: table.source_name,
          table: table.table_name,
          tableKind: table.table_kind,
          updatedAt: table.updated_at,
        };
      }),
      version: 1,
    };
  }

  private getAgentApiFeedTable(tableName: string, searchParams: URLSearchParams) {
    this.ensureAgentSchema();
    const table = this.sql<{ columns_json: string; metadata_json: string | null; row_count: number; source_name: string | null; table_kind: string; table_name: string; updated_at: string }>`
      SELECT table_name, COALESCE(source_name, table_kind) AS source_name, columns_json, row_count, table_kind, metadata_json, updated_at
      FROM agent_table_mappings
      WHERE table_name = ${tableName}
      LIMIT 1
    `[0];
    if (!table) return json({ error: "Table not found." }, { status: 404 });
    const limit = this.clampInteger(searchParams.get("limit"), 100, 1, 1000);
    const offset = this.clampInteger(searchParams.get("offset"), 0, 0, 1_000_000);
    const rows = this.cleanedRowsForTable(tableName, limit, offset);
    const columns = parseStringArray(table.columns_json);
    const format = searchParams.get("format")?.toLowerCase();
    if (format === "csv") {
      const csv = this.rowsToCsv(columns, rows);
      return new Response(csv, {
        headers: {
          "content-disposition": `inline; filename="${this.safeSqlIdentifier(tableName)}.csv"`,
          "content-type": "text/csv; charset=utf-8",
        },
      });
    }
    return json({
      columns: columns.map((column) => ({ name: column, type: this.inferApiColumnType(rows, column) })),
      limit,
      metadata: this.parseJsonObject(table.metadata_json),
      offset,
      rowCount: table.row_count,
      rows,
      sourceName: table.source_name,
      table: table.table_name,
      tableKind: table.table_kind,
      updatedAt: table.updated_at,
    });
  }

  private cleanedRowsForTable(tableName: string, limit: number, offset: number) {
    return [...this.ctx.storage.sql.exec(`SELECT * FROM ${this.quoteIdentifier(tableName)} LIMIT ? OFFSET ?`, limit, offset)].map((row) =>
      Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, this.cleanApiValue(value)])),
    );
  }

  private cleanApiValue(value: unknown): string | number | boolean | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" || typeof value === "boolean") return value;
    const text = String(value).trim();
    if (!text) return null;
    if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) && !/^0\d+/.test(text.replace("-", ""))) {
      const number = Number(text);
      if (Number.isFinite(number)) return number;
    }
    return text;
  }

  private inferApiColumnType(rows: Array<Record<string, unknown>>, column: string) {
    const values = rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined);
    if (values.length === 0) return "string";
    if (values.every((value) => typeof value === "number")) return "number";
    if (values.every((value) => typeof value === "boolean")) return "boolean";
    return "string";
  }

  private rowsToCsv(columns: string[], rows: Array<Record<string, unknown>>) {
    const escape = (value: unknown) => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [columns.map(escape).join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
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

  private async createCleanAgentTable(name: string, description: string, javascript: string) {
    this.ensureAgentSchema();
    const startedAt = Date.now();
    const tableName = this.safeSqlIdentifier(`clean_${name}`);
    const snapshot = this.exportAgentSnapshot(1000);
    const worker = this.env.LOADER.load({
      compatibilityDate: "2026-06-24",
      globalOutbound: null,
      limits: { cpuMs: 50, subRequests: 0 },
      mainModule: "src/index.js",
      modules: { "src/index.js": javascript },
    });
    const entrypoint = worker.getEntrypoint();
    const response = await entrypoint.fetch(
      new Request("https://clean-table.local/transform", {
        body: JSON.stringify({ database: snapshot.database, request: { description, name }, tables: snapshot.tables }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    if (!response.ok) {
      throw new Error((await response.text()) || `Dynamic Worker failed with HTTP ${response.status}.`);
    }
    const text = await response.text();
    if (text.length > 8_000_000) throw new Error("Clean table output is too large.");
    const cleaned = this.normalizeCleanTableOutput(JSON.parse(text), name, description);
    this.importCleanTable(tableName, cleaned);
    this.recordTrace({
      detail: { columns: cleaned.columns, description: cleaned.description, grain: cleaned.grain, rowCount: cleaned.rows.length, tableName },
      durationMs: Date.now() - startedAt,
      spanType: "clean_table",
      status: "done",
      title: `Created clean table ${tableName}`,
    });
    return { columns: cleaned.columns, description: cleaned.description, grain: cleaned.grain, rowCount: cleaned.rows.length, tableName };
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

  private exportAgentSnapshot(limit = 500) {
    const tables = this.sql<{ table_name: string }>`SELECT table_name FROM agent_table_mappings ORDER BY table_name`;
    return {
      database: this.describeAgentDatabase(),
      tables: Object.fromEntries(
        tables.map((table) => [table.table_name, [...this.ctx.storage.sql.exec(`SELECT * FROM ${this.quoteIdentifier(table.table_name)} LIMIT ?`, limit)]]),
      ),
    };
  }

  private importCleanTable(
    tableName: string,
    cleaned: { columns: string[]; description: string; grain: string; metadata: Record<string, unknown>; rows: Record<string, string | number | boolean | null>[] },
  ) {
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${this.quoteIdentifier(tableName)}`);
    const uniqueColumns = this.uniqueSqlColumns(cleaned.columns);
    const defs = uniqueColumns.map((column) => `${this.quoteIdentifier(column)} TEXT`).join(", ");
    this.ctx.storage.sql.exec(`CREATE TABLE ${this.quoteIdentifier(tableName)} (${defs || `${this.quoteIdentifier("value")} TEXT`})`);
    const insertSql = [
      `INSERT INTO ${this.quoteIdentifier(tableName)}`,
      `(${uniqueColumns.map((column) => this.quoteIdentifier(column)).join(", ")})`,
      `VALUES (${uniqueColumns.map(() => "?").join(", ")})`,
    ].join(" ");
    for (const row of cleaned.rows) {
      this.ctx.storage.sql.exec(insertSql, ...uniqueColumns.map((column) => String(row[column] ?? "")));
    }
    this.sql`
      INSERT INTO agent_table_mappings (table_name, spreadsheet_id, source_table_name, source_name, category, columns_json, row_count, table_kind, metadata_json, updated_at)
      VALUES (
        ${tableName},
        NULL,
        NULL,
        ${cleaned.description},
        ${"Cleaned"},
        ${JSON.stringify(uniqueColumns)},
        ${cleaned.rows.length},
        ${"cleaned"},
        ${JSON.stringify({ ...cleaned.metadata, description: cleaned.description, grain: cleaned.grain })},
        ${new Date().toISOString()}
      )
      ON CONFLICT(table_name) DO UPDATE SET
        source_name = excluded.source_name,
        category = excluded.category,
        columns_json = excluded.columns_json,
        row_count = excluded.row_count,
        table_kind = excluded.table_kind,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `;
  }

  private normalizeCleanTableOutput(value: unknown, requestedName: string, requestedDescription: string) {
    const input = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    if (!input) throw new Error("Clean table worker must return a JSON object.");
    if (!Array.isArray(input.rows)) throw new Error("Clean table worker output must include rows array.");
    if (input.rows.length > 20_000) throw new Error("Clean table output has too many rows. Limit is 20,000.");

    const rawColumns = Array.isArray(input.columns) ? input.columns.map((column) => String(column).trim()).filter(Boolean) : [];
    const inferredColumns = new Set(rawColumns);
    for (const row of input.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Every clean table row must be an object.");
      Object.keys(row as Record<string, unknown>).forEach((column) => inferredColumns.add(column));
    }
    for (const provenanceColumn of ["source_table", "source_row", "source_ref"]) inferredColumns.add(provenanceColumn);
    const originalColumns = [...inferredColumns];
    const columns = this.uniqueSqlColumns(originalColumns);
    if (columns.length === 0) throw new Error("Clean table worker output must include at least one column.");

    const rows = input.rows.map((rawRow, index) => {
      const row = rawRow as Record<string, unknown>;
      const normalized: Record<string, string | number | boolean | null> = {};
      originalColumns.forEach((originalColumn, columnIndex) => {
        normalized[columns[columnIndex]] = this.normalizeSqlCell(row[originalColumn]);
      });
      const sourceTableColumn = columns[originalColumns.indexOf("source_table")];
      const sourceRowColumn = columns[originalColumns.indexOf("source_row")];
      const sourceRefColumn = columns[originalColumns.indexOf("source_ref")];
      if (sourceTableColumn) normalized[sourceTableColumn] = this.normalizeSqlCell(row.source_table) ?? "unknown";
      if (sourceRowColumn) normalized[sourceRowColumn] = this.normalizeSqlCell(row.source_row) ?? index + 1;
      if (sourceRefColumn) {
        const sourceTable = sourceTableColumn ? normalized[sourceTableColumn] : "unknown";
        const sourceRow = sourceRowColumn ? normalized[sourceRowColumn] : index + 1;
        normalized[sourceRefColumn] = this.normalizeSqlCell(row.source_ref) ?? `${sourceTable}!row:${sourceRow}`;
      }
      return normalized;
    });

    const metadataInput = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? (input.metadata as Record<string, unknown>) : {};
    return {
      columns,
      description: typeof input.description === "string" && input.description.trim() ? input.description.trim() : requestedDescription,
      grain: typeof input.grain === "string" && input.grain.trim() ? input.grain.trim() : "One row per cleaned observation.",
      metadata: {
        ...metadataInput,
        requestedName,
        source_summary: typeof input.source_summary === "string" ? input.source_summary : metadataInput.source_summary,
      },
      rows,
    };
  }

  private normalizeSqlCell(value: unknown): string | number | boolean | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    return JSON.stringify(value);
  }

  private parseJsonObject(text: string | null) {
    if (!text) return null;
    try {
      const value = JSON.parse(text) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  private clampInteger(value: string | null | undefined, fallback: number, min: number, max: number) {
    const parsed = Number.parseInt(value ?? "", 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  private deleteLibraryAgentData(dropTraces = true) {
    this.ensureAgentSchema();
    const tables = this.sql<{ table_name: string }>`SELECT table_name FROM agent_table_mappings`;
    for (const table of tables) this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS ${this.quoteIdentifier(table.table_name)}`);
    this.sql`DELETE FROM agent_table_mappings`;
    this.sql`DELETE FROM agent_sources`;
    this.sql`DELETE FROM agent_metadata`;
    this.sql`DELETE FROM agent_reports`;
    this.sql`DELETE FROM agent_songs`;
    if (dropTraces) this.sql`DELETE FROM agent_traces`;
    this.clearChatMessages();
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
