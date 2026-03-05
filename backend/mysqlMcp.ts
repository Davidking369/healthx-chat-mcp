import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mysql from "mysql2/promise";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const pool = mysql.createPool({
  host:     process.env.MYSQL_HOST,
  port:     Number(process.env.MYSQL_PORT) || 3306,
  user:     process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  ssl: { rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 10
});

const server = new McpServer({ name: "healthx-mysql", version: "1.0.0" });

server.tool("query", "Run a SELECT query", { sql: z.string() }, async ({ sql }) => {
  if (!sql.trim().toUpperCase().startsWith("SELECT"))
    throw new Error("Only SELECT queries allowed");
  const [rows] = await pool.execute(sql);
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
});

server.tool("execute", "Run INSERT, UPDATE or DELETE",
  { sql: z.string(), params: z.array(z.any()).optional() },
  async ({ sql, params = [] }) => {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith("DROP") || upper.startsWith("TRUNCATE"))
      throw new Error("DROP and TRUNCATE are blocked");
    const [result] = await pool.execute(sql, params);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool("list_tables", "List all tables", {}, async () => {
  const [rows] = await pool.execute("SHOW TABLES");
  return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
});

server.tool("describe_table", "Get schema of a table",
  { table: z.string() },
  async ({ table }) => {
    const [rows] = await pool.execute(`DESCRIBE \`${table}\``);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
