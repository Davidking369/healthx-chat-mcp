import express from "express";
import cors from "cors";
import Groq from "groq-sdk";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── Groq Client ────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── MySQL Pool ─────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.MYSQL_HOST || "127.0.0.1",
  port:     Number(process.env.MYSQL_PORT) || 3306,
  user:     process.env.MYSQL_USER || "healthx_user",
  password: process.env.MYSQL_PASSWORD || "healthx_pass",
  database: process.env.MYSQL_DATABASE || "healthx_db",
  waitForConnections: true,
  connectionLimit: 10
});

// ── Tools Definition ───────────────────────────────────
const tools: any[] = [
  {
    type: "function",
    function: {
      name: "query",
      description: "Run a read-only SELECT query on the MySQL database",
      parameters: {
        type: "object",
        properties: { sql: { type: "string", description: "SELECT SQL query" } },
        required: ["sql"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tables",
      description: "List all tables in the database",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "describe_table",
      description: "Get columns and schema of a specific table",
      parameters: {
        type: "object",
        properties: { table: { type: "string", description: "Table name" } },
        required: ["table"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "execute",
      description: "Run INSERT, UPDATE or DELETE SQL statement",
      parameters: {
        type: "object",
        properties: { sql: { type: "string", description: "SQL statement" } },
        required: ["sql"]
      }
    }
  }
];

// ── Tool Executor ──────────────────────────────────────
async function runTool(name: string, args: any): Promise<string> {
  switch (name) {
    case "query": {
      if (!args.sql.trim().toUpperCase().startsWith("SELECT"))
        throw new Error("Only SELECT queries allowed");
      const [rows] = await pool.execute(args.sql);
      return JSON.stringify(rows, null, 2);
    }
    case "list_tables": {
      const [rows] = await pool.execute("SHOW TABLES");
      return JSON.stringify(rows, null, 2);
    }
    case "describe_table": {
      const [rows] = await pool.execute(`DESCRIBE \`${args.table}\``);
      return JSON.stringify(rows, null, 2);
    }
    case "execute": {
      const upper = args.sql.trim().toUpperCase();
      if (upper.startsWith("DROP") || upper.startsWith("TRUNCATE"))
        throw new Error("DROP/TRUNCATE blocked for safety");
      const [result] = await pool.execute(args.sql);
      return JSON.stringify(result, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Direct Tool Endpoint (for alerts) ─────────────────
app.post("/tool", async (req, res) => {
  const { tool, args } = req.body;
  try {
    const result = await runTool(tool, args);
    res.json({ result });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Health Check ───────────────────────────────────────
app.get("/health", async (_, res) => {
  try {
    await pool.execute("SELECT 1");
    res.json({ status: "ok", db: "connected", provider: "Groq llama3-70b" });
  } catch (e: any) {
    res.json({ status: "ok", db: "error: " + e.message, provider: "Groq llama3-70b" });
  }
});

// ── Chat Endpoint ──────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { messages } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const systemMessage = {
      role: "system" as const,
      content: `You are HealthX AI, a helpful assistant with access to a MySQL database.
Use the available tools to answer questions accurately.
Always explain what you found in a clear, friendly way.`
    };

    let currentMessages: any[] = [
      systemMessage,
      ...messages.map((m: any) => ({ role: m.role, content: m.content }))
    ];

    // Agentic loop
    while (true) {
      const stream = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: currentMessages,
        tools,
        tool_choice: "auto",
        stream: true,
        max_tokens: 4096
      });

      let fullText = "";
      let toolCalls: any[] = [];
      let currentToolCall: any = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        // Stream text
        if (delta?.content) {
          fullText += delta.content;
          send({ type: "text", content: delta.content });
        }

        // Accumulate tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: "", type: "function", function: { name: "", arguments: "" } };
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) {
                toolCalls[tc.index].function.name = tc.function.name;
                send({ type: "tool_start", tool: tc.function.name });
              }
              if (tc.function?.arguments) {
                toolCalls[tc.index].function.arguments += tc.function.arguments;
              }
            }
          }
        }

        if (chunk.choices[0]?.finish_reason === "stop") {
          send({ type: "done" });
          res.end();
          return;
        }

        if (chunk.choices[0]?.finish_reason === "tool_calls") break;
      }

      // No tool calls — done
      if (toolCalls.length === 0) {
        send({ type: "done" });
        res.end();
        break;
      }

      // Add assistant message with tool calls
      currentMessages.push({
        role: "assistant",
        content: fullText || null,
        tool_calls: toolCalls
      });

      // Execute each tool
      for (const tc of toolCalls) {
        try {
          const args = JSON.parse(tc.function.arguments || "{}");
          send({ type: "tool_running", tool: tc.function.name, input: args });
          const result = await runTool(tc.function.name, args);
          send({ type: "tool_result", tool: tc.function.name, result });
          currentMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result
          });
        } catch (err: any) {
          currentMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `Error: ${err.message}`
          });
        }
      }
    }

  } catch (err: any) {
    send({ type: "error", message: err.message });
    res.end();
  }
});

// ── Start ──────────────────────────────────────────────
app.listen(process.env.PORT || 3001, () => {
  console.log("🚀 HealthX backend → http://localhost:3001");
  console.log("🤖 Provider: Groq llama3-70b (Free)");
});
