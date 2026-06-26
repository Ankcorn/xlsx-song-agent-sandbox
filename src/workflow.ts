import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, ExtractionWorkflowParams } from "./http";

type WorkflowExtractorKind = "xlsx" | "ods" | "other";

function selectWorkflowExtractor(filename: string, contentType: string): WorkflowExtractorKind {
  const lowerName = filename.toLowerCase();
  const lowerType = contentType.toLowerCase();
  if (lowerName.endsWith(".xlsx") || lowerType.includes("spreadsheetml")) return "xlsx";
  if (lowerName.endsWith(".ods") || lowerType.includes("opendocument.spreadsheet")) return "ods";
  return "other";
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

      const extractorKind = await step.do("select format-specific extractor", async () => {
        const selected = selectWorkflowExtractor(payload.filename, payload.contentType);
        await stub.fetch("https://agent.local/upload-trace", {
          body: JSON.stringify({
            detail: {
              contentType: payload.contentType,
              extractor: selected,
              filename: payload.filename,
            },
            spanType: "workflow",
            status: "done",
            title: `Workflow selected ${selected.toUpperCase()} extractor`,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        return selected;
      });

      const analysis = await step.do("run codemode extraction", async () => {
        const response = await stub.fetch("https://agent.local/retry-extraction", {
          body: JSON.stringify({
            extractorKind,
            filename: payload.filename,
            sandboxPath: payload.sandboxPath,
            spreadsheetId: payload.spreadsheetId,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        if (!response.ok) throw new Error((await response.text()) || "Failed to analyze spreadsheet file.");
        return response.json() as Promise<Record<string, string | number>>;
      });

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
