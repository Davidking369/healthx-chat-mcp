import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { initMCP, callMCPTool, getMCPTools } from "./mcpClient.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

await initMCP();

app.get("/health", (_, res) => res.json({
  status: "ok",
  tools: getMCPTools().map((t: any) => t.name)
}));

app.post("/chat", async (req, res) => {
  const { messages } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    let currentMessages = [...messages];

    while (true) {
      const stream = await anthropic.messages.stream({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: `You are HealthX AI, a helpful assistant with access to a MySQL database.
                 Use tools to answer questions accurately. Explain what you're doing.`,
        tools: getMCPTools(),
        messages: currentMessages
      });

      let toolUses: any[] = [];

      for await (const chunk of stream) {
        if (chunk.type === "content_block_delta") {
          if (chunk.delta.type === "text_delta") {
            send({ type: "text", content: chunk.delta.text });
          }
        }
        if (chunk.type === "content_block_start" &&
            chunk.content_block.type === "tool_use") {
          send({ type: "tool_start", tool: chunk.content_block.name });
        }
      }

      const finalMessage = await stream.finalMessage();

      if (finalMessage.stop_reason !== "tool_use") {
        send({ type: "done" });
        break;
      }

      const toolResults = [];
      for (const block of finalMessage.content) {
        if (block.type === "tool_use") {
          try {
            send({ type: "tool_running", tool: block.name, input: block.input });
            const result = await callMCPTool(block.name, block.input);
            send({ type: "tool_result", tool: block.name, result });
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result)
            });
          } catch (err: any) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Error: ${err.message}`,
              is_error: true
            });
          }
        }
      }

      currentMessages = [
        ...currentMessages,
        { role: "assistant", content: finalMessage.content },
        { role: "user", content: toolResults }
      ];
    }
  } catch (err: any) {
    send({ type: "error", message: err.message });
    res.end();
  }
});

app.listen(process.env.PORT || 3001, () => {
  console.log(`🚀 HealthX backend running on port ${process.env.PORT || 3001}`);
});
