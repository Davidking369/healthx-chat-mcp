import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const pool = mysql.createPool({
  host:     process.env.MYSQL_HOST || "127.0.0.1",
  port:     Number(process.env.MYSQL_PORT) || 3306,
  user:     process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10
});

const server = new Server(
  { name: "healthx-mysql", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: "query",
    description: "Run a SELECT query on the MySQL database",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string", description: "SELECT SQL query" } },
      required: ["sql"]
    }
  },
  {
    name: "execute",
    description: "Run INSERT, UPDATE or DELETE query",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string" },
        params: { type: "array", items: {} }
      },
      required: ["sql"]
    }
  },
  {
    name: "list_tables",
    description: "List all tables in the database",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "describe_table",
    description: "Get schema/columns of a table",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string" } },
      required: ["table"]
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "query") {
      const sql = (args as any).sql;
      if (!sql.trim().toUpperCase().startsWith("SELECT"))
        throw new Error("Only SELECT queries allowed");
      const [rows] = await pool.execute(sql);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }

    if (name === "execute") {
      const { sql, params = [] } = args as any;
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith("DROP") || upper.startsWith("TRUNCATE"))
        throw new Error("DROP and TRUNCATE are blocked");
      const [result] = await pool.execute(sql, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "list_tables") {
      const [rows] = await pool.execute("SHOW TABLES");
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }

    if (name === "describe_table") {
      const { table } = args as any;
      const [rows] = await pool.execute(`DESCRIBE \`${table}\``);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("✅ HealthX MySQL MCP server running");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
