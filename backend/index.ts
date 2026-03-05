import express from "express";
import cors from "cors";
import { GoogleGenerativeAI, FunctionCallingMode, FunctionDeclarationSchemaType } from "@google/generative-ai";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const pool = mysql.createPool({
  host:     process.env.MYSQL_HOST || "127.0.0.1",
  port:     Number(process.env.MYSQL_PORT) || 3306,
  user:     process.env.MYSQL_USER || "healthx_user",
  password: process.env.MYSQL_PASSWORD || "healthx_pass",
  database: process.env.MYSQL_DATABASE || "healthx_db",
  waitForConnections: true,
  connectionLimit: 10
});

const tools = [
  {
    name: "query",
    description: "Run a SELECT query on the MySQL database",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: { sql: { type: FunctionDeclarationSchemaType.STRING, description: "SELECT SQL query" } },
      required: ["sql"]
    }
  },
  {
    name: "list_tables",
    description: "List all tables in the database",
    parameters: { type: FunctionDeclarationSchemaType.OBJECT, properties: {} }
  },
  {
    name: "describe_table",
    description: "Get columns and schema of a table",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: { table: { type: FunctionDeclarationSchemaType.STRING, description: "Table name" } },
      required: ["table"]
    }
  },
  {
    name: "execute",
    description: "Run INSERT, UPDATE or DELETE SQL",
    parameters: {
      type: FunctionDeclarationSchemaType.OBJECT,
      properties: { sql: { type: FunctionDeclarationSchemaType.STRING, description: "SQL statement" } },
      required: ["sql"]
    }
  }
];

async function runTool(name: string, args: any): Promise<string> {
  switch (name) {
    case "query": {
      if (!args.sql.trim().toUpperCase().startsWith("SELECT")) throw new Error("Only SELECT allowed");
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
      if (upper.startsWith("DROP") || upper.startsWith("TRUNCATE")) throw new Error("Blocked");
      const [result] = await pool.execute(args.sql);
      return JSON.stringify(result, null, 2);
    }
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

app.get("/health", async (_, res) => {
  try {
    await pool.execute("SELECT 1");
    res.json({ status: "ok", db: "connected", provider: "Gemini 1.5 Flash" });
  } catch (e: any) {
    res.json({ status: "ok", db: "error: " + e.message });
  }
});

app.post("/chat", async (req, res) => {
  const { messages } = req.body;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const geminiHistory = messages.slice(0, -1).map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));
    const lastMessage = messages[messages.length - 1].content;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: "You are HealthX AI, a helpful assistant with MySQL database access. Use tools to answer questions accurately.",
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } }
    });

    const chat = model.startChat({ history: geminiHistory });
    let userInput: any = lastMessage;

    while (true) {
      const result = await chat.sendMessageStream(userInput);

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) send({ type: "text", content: text });
      }

      const response = await result.response;
      const calls = response.functionCalls();

      if (!calls || calls.length === 0) { send({ type: "done" }); break; }

      const functionResponses = [];
      for (const call of calls) {
        try {
          send({ type: "tool_start", tool: call.name });
          send({ type: "tool_running", tool: call.name, input: call.args });
          const toolResult = await runTool(call.name, call.args);
          send({ type: "tool_result", tool: call.name, result: toolResult });
          functionResponses.push({ functionResponse: { name: call.name, response: { result: toolResult } } });
        } catch (err: any) {
          functionResponses.push({ functionResponse: { name: call.name, response: { error: err.message } } });
        }
      }
      userInput = functionResponses;
    }
  } catch (err: any) {
    send({ type: "error", message: err.message });
    res.end();
  }
});

app.listen(process.env.PORT || 3001, () => {
  console.log("🚀 HealthX backend → http://localhost:3001");
  console.log("🤖 Provider: Google Gemini 1.5 Flash (Free)");
});
