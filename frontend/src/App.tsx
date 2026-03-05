import { useState, useRef, useEffect } from "react";
import Message from "./components/Message";
import "./App.css";

type Msg = { role: "user" | "assistant"; content: string; toolCalls?: any[] };

export default function App() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [toolStatus, setToolStatus] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, toolStatus]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;
    const userMsg: Msg = { role: "user", content: input };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setIsLoading(true);
    setToolStatus("");
    setMessages(prev => [...prev, { role: "assistant", content: "", toolCalls: [] }]);

    try {
      const response = await fetch("/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(m => ({ role: m.role, content: m.content })) })
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = JSON.parse(line.slice(6));

          if (data.type === "text") {
            setMessages(prev => {
              const updated = [...prev];
              const last = { ...updated[updated.length - 1] };
              last.content += data.content;
              updated[updated.length - 1] = last;
              return updated;
            });
          }
          if (data.type === "tool_start") setToolStatus(`🔧 Calling: ${data.tool}...`);
          if (data.type === "tool_running") setToolStatus(`⚙️ Running: ${data.tool}`);
          if (data.type === "tool_result") {
            setToolStatus("");
            setMessages(prev => {
              const updated = [...prev];
              const last = { ...updated[updated.length - 1] };
              last.toolCalls = [...(last.toolCalls || []), { tool: data.tool, result: data.result }];
              updated[updated.length - 1] = last;
              return updated;
            });
          }
          if (data.type === "done") { setToolStatus(""); setIsLoading(false); }
          if (data.type === "error") { setToolStatus(`❌ ${data.message}`); setIsLoading(false); }
        }
      }
    } catch (err) {
      console.error(err);
      setIsLoading(false);
    }
  };

  const suggestions = ["Show all tables", "How many users signed up today?",
    "List pending orders", "Show recent errors in logs"];

  return (
    <div className="app">
      <header className="header">
        <div className="logo">✦ HealthX AI</div>
        <div className="status"><span className="dot green"></span> MCP Connected</div>
      </header>
      <main className="chat-window">
        {messages.length === 0 && (
          <div className="empty-state">
            <h2>✦ How can I help you?</h2>
            <div className="suggestions">
              {suggestions.map(s => (
                <button key={s} onClick={() => setInput(s)} className="suggestion">{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <Message key={i} role={msg.role} content={msg.content} toolCalls={msg.toolCalls} />
        ))}
        {toolStatus && <div className="tool-status">{toolStatus}</div>}
        <div ref={bottomRef} />
      </main>
      <footer className="input-bar">
        <input value={input} onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
          placeholder="Ask anything about your database..." disabled={isLoading} />
        <button onClick={sendMessage} disabled={isLoading || !input.trim()}>
          {isLoading ? "⏳" : "↑"}
        </button>
      </footer>
    </div>
  );
}
