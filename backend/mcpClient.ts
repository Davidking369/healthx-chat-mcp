import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let mcpClient: Client | null = null;
let mcpTools: any[] = [];

export async function initMCP() {
  try {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["ts-node", "./mysqlMcp.ts"],
      env: {
        ...process.env,
        MYSQL_HOST: process.env.MYSQL_HOST!,
        MYSQL_USER: process.env.MYSQL_USER!,
        MYSQL_PASSWORD: process.env.MYSQL_PASSWORD!,
        MYSQL_DATABASE: process.env.MYSQL_DATABASE!,
      }
    });

    mcpClient = new Client({ name: "healthx-chat", version: "1.0.0" }, {
      capabilities: { tools: {} }
    });

    await mcpClient.connect(transport);

    const { tools } = await mcpClient.listTools();
    mcpTools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }));

    console.log(`✅ MCP connected. Tools: ${mcpTools.map((t: any) => t.name).join(", ")}`);
  } catch (err) {
    console.error("❌ MCP connection failed:", err);
  }
}
export async function callMCPTool(name: string, input: any) {
  if (!mcpClient) throw new Error("MCP not connected");
  const result = await mcpClient.callTool({ name, arguments: input });
  return result.content;
}

export function getMCPTools() {
  return mcpTools;
}
