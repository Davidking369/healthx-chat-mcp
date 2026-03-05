import express from "express";
import cors from "cors";
import Groq from "groq-sdk";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Dynamic Pool Cache ─────────────────────────────────
// One pool per unique DB connection, reused across requests
const poolCache = new Map<string, mysql.Pool>();

function getPoolKey(db: any): string {
  return `${db.host}:${db.port}:${db.user}:${db.database}`;
}

function getPool(db?: any): mysql.Pool {
  // If no db config sent, fall back to .env defaults
  const config = {
    host:     db?.host     || process.env.MYSQL_HOST     || "127.0.0.1",
    port:     db?.port     || Number(process.env.MYSQL_PORT) || 3306,
    user:     db?.user     || process.env.MYSQL_USER     || "healthx_user",
    password: db?.pass     || process.env.MYSQL_PASSWORD || "healthx_pass",
    database: db?.database || process.env.MYSQL_DATABASE || "healthx_db",
  };

  const key = getPoolKey(config);

  if (!poolCache.has(key)) {
    console.log(`🔌 Creating new pool for: ${config.host}:${config.port}/${config.database}`);
    poolCache.set(key, mysql.createPool({
      ...config,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 10000,
    }));
  }

  return poolCache.get(key)!;
}

// ── Tools ──────────────────────────────────────────────
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

// ── Tool Executor (pool-aware) ─────────────────────────
async function runTool(name: string, args: any, pool: mysql.Pool): Promise<string> {
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

// ── Test DB Connection ─────────────────────────────────
app.post("/test-db", async (req, res) => {
  const { db } = req.body;
  try {
    const pool = getPool(db);
    await pool.execute("SELECT 1");
    res.json({ status: "connected", message: `Connected to ${db?.database || "database"}` });
  } catch (e: any) {
    res.status(400).json({ status: "error", message: e.message });
  }
});

// ── Direct Tool Endpoint (for alerts) ─────────────────
app.post("/tool", async (req, res) => {
  const { tool, args, db } = req.body;
  try {
    const pool = getPool(db);
    const result = await runTool(tool, args, pool);
    res.json({ result });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Health Check ───────────────────────────────────────
app.get("/health", async (req, res) => {
  const db = req.query.db ? JSON.parse(req.query.db as string) : undefined;
  try {
    const pool = getPool(db);
    await pool.execute("SELECT 1");
    const config = {
      host: db?.host || process.env.MYSQL_HOST || "127.0.0.1",
      database: db?.database || process.env.MYSQL_DATABASE || "healthx_db"
    };
    res.json({
      status: "ok",
      db: "connected",
      connection: `${config.host}/${config.database}`,
      provider: "Groq llama-3.3-70b",
      activePools: poolCache.size
    });
  } catch (e: any) {
    res.json({ status: "ok", db: "error: " + e.message, provider: "Groq llama-3.3-70b" });
  }
});

// ── Chat Endpoint ──────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { messages, db } = req.body; // db comes from frontend active DB

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Get pool for the selected DB
    const pool = getPool(db);

    // Verify connection before starting
    await pool.execute("SELECT 1");

    const dbName = db?.database || process.env.MYSQL_DATABASE || "healthx_db";
    const dbHost = db?.host || process.env.MYSQL_HOST || "127.0.0.1";

    const systemMessage = {
      role: "system" as const,
      content: `You are HealthX AI, a helpful assistant with access to a MySQL database.
Current database: ${dbName} on ${dbHost}.
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

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          fullText += delta.content;
          send({ type: "text", content: delta.content });
        }

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

      if (toolCalls.length === 0) {
        send({ type: "done" });
        res.end();
        break;
      }

      currentMessages.push({
        role: "assistant",
        content: fullText || null,
        tool_calls: toolCalls
      });

      // Execute tools using the selected DB pool
      for (const tc of toolCalls) {
        try {
          const args = JSON.parse(tc.function.arguments || "{}");
          send({ type: "tool_running", tool: tc.function.name, input: args });
          const result = await runTool(tc.function.name, args, pool);
          send({ type: "tool_result", tool: tc.function.name, result });
          currentMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
        } catch (err: any) {
          send({ type: "tool_result", tool: tc.function.name, result: `Error: ${err.message}` });
          currentMessages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${err.message}` });
        }
      }
    }

  } catch (err: any) {
    // Friendly error if DB connection fails
    if (err.code === 'ECONNREFUSED' || err.code === 'ER_ACCESS_DENIED_ERROR' || err.code === 'ENOTFOUND') {
      send({ type: "error", message: `Cannot connect to database: ${err.message}` });
    } else {
      send({ type: "error", message: err.message });
    }
    res.end();
  }
});

app.listen(process.env.PORT || 3001, () => {
  console.log("🚀 HealthX backend → http://localhost:3001");
  console.log("🤖 Provider: Groq llama-3.3-70b (Free)");
  console.log("🗄️  Dynamic multi-DB support enabled");
});
