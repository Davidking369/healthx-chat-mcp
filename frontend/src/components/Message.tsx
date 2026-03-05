import ReactMarkdown from "react-markdown";

type Props = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { tool: string; input?: any; result?: any }[];
};

export default function Message({ role, content, toolCalls }: Props) {
  return (
    <div className={`message ${role}`}>
      <div className="avatar">{role === "user" ? "👤" : "✦"}</div>
      <div className="message-body">
        {toolCalls && toolCalls.length > 0 && (
          <div className="tool-calls">
            {toolCalls.map((tc, i) => (
              <details key={i} className="tool-call">
                <summary>🔧 Tool used: <code>{tc.tool}</code></summary>
                {tc.input && <pre className="tool-input">{JSON.stringify(tc.input, null, 2)}</pre>}
                {tc.result && <pre className="tool-result">{JSON.stringify(tc.result, null, 2)}</pre>}
              </details>
            ))}
          </div>
        )}
        <div className="content">
          {role === "assistant"
            ? <ReactMarkdown>{content}</ReactMarkdown>
            : <p>{content}</p>
          }
        </div>
      </div>
    </div>
  );
}
