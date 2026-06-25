import { getSandbox, proxyToSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";
import { Think } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  AI: Ai;
  ASSETS: Fetcher;
  HackathonAgent: DurableObjectNamespace<HackathonAgent>;
  Sandbox: DurableObjectNamespace<SandboxType>;
};

const DEFAULT_SCRIPT = [
  "from datetime import datetime",
  "numbers = [3, 5, 8, 13]",
  "print('Hello from Cloudflare Sandbox Python!')",
  "print('sum =', sum(numbers))",
  "print('utc =', datetime.utcnow().isoformat(timespec='seconds'))",
].join("\n");

async function runPython(env: Env, code = DEFAULT_SCRIPT) {
  const sandbox = getSandbox(env.Sandbox, "hackathon-python");
  const result = await sandbox.exec(`python3 - <<'PY'\n${code}\nPY`, {
    timeout: 15_000,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    success: result.success,
  };
}

export class HackathonAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.7-code");
  }

  getSystemPrompt() {
    return [
      "You are a practical hackathon coding assistant.",
      "When the user asks to run Python, use execute_python and explain the result briefly.",
      "Keep answers concise, concrete, and useful.",
    ].join("\n");
  }

  getTools() {
    return {
      execute_python: tool({
        description: "Execute a short Python script inside a Cloudflare Sandbox container.",
        inputSchema: z.object({
          code: z.string().min(1).describe("Python source code to run."),
        }),
        execute: async ({ code }) => runPython(this.env, code),
      }),
    };
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

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
