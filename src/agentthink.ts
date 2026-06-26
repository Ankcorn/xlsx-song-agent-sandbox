import { getSandbox } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import { generateText, stepCountIs, tool } from "ai";
import { createAiGateway } from "ai-gateway-provider";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import {
  configuredModelEntries,
  json,
  jsonRenderResponseInstructions,
  modelConfig,
  parseStringArray,
  providerModel,
  safeTraceDetail,
  type AgentInitializationPayload,
  type AgentRequestPayload,
  type AgentTraceEvent,
  type Env,
  type TraceInput,
} from "./http";

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
        metadata_json TEXT,
        updated_at TEXT NOT NULL
      )
    `;
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
