import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import Groq from "groq-sdk";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Zod Schemas ────────────────────────────────────────

const DbConfigSchema = z.object({
  host:     z.string().min(1),
  port:     z.number().int().min(1).max(65535).default(3306),
  user:     z.string().min(1),
  pass:     z.string(),
  database: z.string().min(1),
}).optional();

const MessageSchema = z.object({
  role:    z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
});

const ChatSchema = z.object({
  messages: z.array(MessageSchema).min(1),
  db:       DbConfigSchema,
});

const ToolSchema = z.object({
  tool: z.enum(["query", "list_tables", "describe_table", "execute"]),
  args: z.record(z.string(), z.unknown()).default({}),
  db:   DbConfigSchema,
});

const SchemaRequestSchema = z.object({
  db: DbConfigSchema,
});

const TestDbSchema = z.object({
  db: DbConfigSchema,
});

// ── Zod Error Middleware ───────────────────────────────

function validate<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data) as z.infer<S>;
}

function zodErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
) {
  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: "Validation failed",
      issues: err.issues.map(e => ({
        path:    e.path.join("."),
        message: e.message,
      })),
    });
    return;
  }
  next(err);
}

// ── Dynamic Pool Cache ─────────────────────────────────

const poolCache = new Map<string, mysql.Pool>();

function getPool(db?: z.infer<typeof DbConfigSchema>): mysql.Pool {
  const config = {
    host:     db?.host     ?? process.env.MYSQL_HOST     ?? "127.0.0.1",
    port:     db?.port     ?? (Number(process.env.MYSQL_PORT) || 3306),
    user:     db?.user     ?? process.env.MYSQL_USER     ?? "healthx_user",
    password: db?.pass     ?? process.env.MYSQL_PASSWORD ?? "healthx_pass",
    database: db?.database ?? process.env.MYSQL_DATABASE ?? "healthx_db",
  };
  const key = `${config.host}:${config.port}:${config.user}:${config.database}`;
  if (!poolCache.has(key)) {
    console.log(`🔌 New pool → ${config.host}:${config.port}/${config.database}`);
    poolCache.set(key, mysql.createPool({
      ...config,
      waitForConnections: true,
      connectionLimit:    10,
      connectTimeout:     10_000,
    }));
  }
  return poolCache.get(key)!;
}

// ── Tools Definition ───────────────────────────────────

const tools: any[] = [
  {
    type: "function",
    function: {
      name: "query",
      description: "Run a read-only SELECT query on the MySQL database",
      parameters: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tables",
      description: "List all tables in the current database",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_table",
      description: "Get columns and schema of a specific table",
      parameters: {
        type: "object",
        properties: { table: { type: "string" } },
        required: ["table"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute",
      description: "Run INSERT, UPDATE or DELETE SQL",
      parameters: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
    },
  },
];

// ── Tool Executor ──────────────────────────────────────

// Zod schemas for each tool's args
const QueryArgs   = z.object({ sql: z.string().min(1) });
const DescribeArgs = z.object({ table: z.string().min(1).regex(/^[\w]+$/, "Invalid table name") });
const ExecuteArgs = z.object({ sql: z.string().min(1) });

async function runTool(name: string, args: unknown, pool: mysql.Pool): Promise<string> {
  switch (name) {
    case "query": {
      const { sql } = QueryArgs.parse(args);
      if (!sql.trim().toUpperCase().startsWith("SELECT"))
        throw new Error("Only SELECT queries allowed in query tool");
      const [rows] = await pool.execute(sql);
      return JSON.stringify(rows, null, 2);
    }
    case "list_tables": {
      const [rows] = await pool.execute("SHOW TABLES");
      return JSON.stringify(rows, null, 2);
    }
    case "describe_table": {
      const { table } = DescribeArgs.parse(args);
      const [rows] = await pool.execute(`DESCRIBE \`${table}\``);
      return JSON.stringify(rows, null, 2);
    }
    case "execute": {
      const { sql } = ExecuteArgs.parse(args);
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("DROP") || upper.startsWith("TRUNCATE"))
        throw new Error("DROP / TRUNCATE are blocked for safety");
      const [result] = await pool.execute(sql);
      return JSON.stringify(result, null, 2);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Schema Endpoint ────────────────────────────────────

app.post("/schema", async (req: Request, res: Response) => {
  try {
    const { db } = validate(SchemaRequestSchema, req.body);
    const pool   = getPool(db);
    const dbName = db?.database ?? process.env.MYSQL_DATABASE ?? "healthx_db";

    const [columns] = await pool.execute(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
              COLUMN_KEY, EXTRA, COLUMN_DEFAULT, ORDINAL_POSITION
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [dbName]
    );

    const [tables] = await pool.execute(
      `SELECT TABLE_NAME, TABLE_ROWS, TABLE_COMMENT
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
      [dbName]
    );

    const [relationships] = await pool.execute(
      `SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME,
              kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
              kcu.CONSTRAINT_NAME
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        AND kcu.TABLE_SCHEMA    = tc.TABLE_SCHEMA
       WHERE kcu.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'`,
      [dbName]
    );

    res.json({ columns, tables, relationships });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", issues: err.issues });
    } else {
      res.status(400).json({ error: err.message });
    }
  }
});

// ── Test DB Connection ─────────────────────────────────

app.post("/test-db", async (req: Request, res: Response) => {
  try {
    const { db } = validate(TestDbSchema, req.body);
    const pool   = getPool(db);
    await pool.execute("SELECT 1");
    res.json({ status: "connected", message: `Connected to ${db?.database ?? "database"}` });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", issues: err.issues });
    } else {
      res.status(400).json({ status: "error", message: err.message });
    }
  }
});

// ── Direct Tool Endpoint (alerts) ─────────────────────

app.post("/tool", async (req: Request, res: Response) => {
  try {
    const { tool, args, db } = validate(ToolSchema, req.body);
    const pool  = getPool(db);
    const result = await runTool(tool, args, pool);
    res.json({ result });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", issues: err.issues });
    } else {
      res.status(400).json({ error: err.message });
    }
  }
});

// ── Health Check ───────────────────────────────────────

app.get("/health", async (req: Request, res: Response) => {
  try {
    const dbParam = req.query.db ? JSON.parse(req.query.db as string) : undefined;
    const db      = dbParam ? DbConfigSchema.parse(dbParam) : undefined;
    const pool    = getPool(db);
    await pool.execute("SELECT 1");
    res.json({
      status:      "ok",
      db:          "connected",
      connection:  `${db?.host ?? process.env.MYSQL_HOST}/${db?.database ?? process.env.MYSQL_DATABASE}`,
      provider:    "Groq llama-3.3-70b",
      activePools: poolCache.size,
    });
  } catch (err: any) {
    res.json({ status: "ok", db: "error: " + err.message });
  }
});

// ── Chat Endpoint ──────────────────────────────────────

app.post("/chat", async (req: Request, res: Response) => {
  // Validate before touching SSE
  let body: z.infer<typeof ChatSchema>;
  try {
    body = validate(ChatSchema, req.body);
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Validation failed", issues: err.issues });
    } else {
      res.status(400).json({ error: err.message });
    }
    return;
  }

  const { messages, db } = body;

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const pool   = getPool(db);
    await pool.execute("SELECT 1"); // early connection check

    const dbName = db?.database ?? process.env.MYSQL_DATABASE ?? "healthx_db";
    const dbHost = db?.host     ?? process.env.MYSQL_HOST     ?? "127.0.0.1";

    const systemMessage = {
      role:    "system" as const,
      content: `You are HealthX AI, a helpful assistant with access to a MySQL database.
Current database: ${dbName} on ${dbHost}.
Use the available tools to answer questions accurately.
Always explain what you found in a clear, friendly way.`,
    };

    let currentMessages: any[] = [
      systemMessage,
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ];

    // Agentic loop
    while (true) {
      const stream = await groq.chat.completions.create({
        model:       "llama-3.3-70b-versatile",
        messages:    currentMessages,
        tools,
        tool_choice: "auto",
        stream:      true,
        max_tokens:  4096,
      });

      let fullText  = "";
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
              if (tc.id)               toolCalls[tc.index].id = tc.id;
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
          send({ type: "done" }); res.end(); return;
        }
        if (chunk.choices[0]?.finish_reason === "tool_calls") break;
      }

      if (toolCalls.length === 0) {
        send({ type: "done" }); res.end(); break;
      }

      currentMessages.push({ role: "assistant", content: fullText || null, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        try {
          const args = JSON.parse(tc.function.arguments || "{}");
          send({ type: "tool_running", tool: tc.function.name, input: args });
          const result = await runTool(tc.function.name, args, pool);
          send({ type: "tool_result", tool: tc.function.name, result });
          currentMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
        } catch (err: any) {
          const msg = err instanceof z.ZodError
            ? `Validation error: ${err.issues.map(e => e.message).join(", ")}`
            : err.message;
          send({ type: "tool_result", tool: tc.function.name, result: `Error: ${msg}` });
          currentMessages.push({ role: "tool", tool_call_id: tc.id, content: `Error: ${msg}` });
        }
      }
    }
  } catch (err: any) {
    send({ type: "error", message: err.message });
    res.end();
  }
});

// ── Global error handler ───────────────────────────────
app.use(zodErrorHandler);

// ── Start ──────────────────────────────────────────────
app.listen(process.env.PORT || 3001, () => {
  console.log("🚀 HealthX backend  → http://localhost:3001");
  console.log("🤖 Provider         → Groq llama-3.3-70b");
  console.log("🗄️  Multi-DB pools  → enabled");
  console.log("✅ Zod validation   → enabled on all endpoints");
});
