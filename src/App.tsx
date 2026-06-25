import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Loader2, Play, Send, Terminal } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type SandboxResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
};

function textFromParts(parts: Array<{ type: string; text?: string }>) {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function App() {
  const agent = useAgent({ agent: "HackathonAgent", name: "main" });
  const { messages, sendMessage, status } = useAgentChat({ agent });
  const [input, setInput] = useState("Run a simple Python script in the sandbox.");
  const [sandboxResult, setSandboxResult] = useState<SandboxResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const isBusy = status === "submitted" || status === "streaming";

  const visibleMessages = useMemo(
    () => messages.filter((message) => textFromParts(message.parts).trim().length > 0),
    [messages],
  );

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isBusy) return;
    sendMessage({ text });
    setInput("");
  }

  async function runSmokeTest() {
    setIsRunning(true);
    try {
      const response = await fetch("/api/run-python");
      setSandboxResult(await response.json());
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="app-shell">
      <section className="chat-pane" aria-label="Agent chat">
        <header className="topbar">
          <div>
            <p className="eyebrow">Cloudflare Agents + Sandbox</p>
            <h1>XLSX Song Hackathon Agent</h1>
          </div>
          <button className="icon-button" type="button" onClick={runSmokeTest} disabled={isRunning}>
            {isRunning ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            <span>Run</span>
          </button>
        </header>

        <div className="messages">
          {visibleMessages.length === 0 ? (
            <div className="empty-state">
              <Terminal size={28} />
              <p>Ask the agent to run Python and it will call the Sandbox tool.</p>
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

        <form className="composer" onSubmit={submitMessage}>
          <input
            aria-label="Message"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask the agent to execute Python..."
          />
          <button className="icon-button" type="submit" disabled={isBusy || !input.trim()}>
            {isBusy ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
          </button>
        </form>
      </section>

      <aside className="result-pane" aria-label="Sandbox result">
        <div className="panel-heading">
          <Terminal size={18} />
          <h2>Sandbox Smoke Test</h2>
        </div>
        <pre>{sandboxResult ? JSON.stringify(sandboxResult, null, 2) : "Click Run to hit /api/run-python."}</pre>
      </aside>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
