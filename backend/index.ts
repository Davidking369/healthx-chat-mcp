import express from "express";
import cors from "cors";
import { GoogleGenerativeAI, FunctionCallingMode } from "@google/generative-ai";
import dotenv from "dotenv";
import { initMCP, callMCPTool, getMCPTools } from "./mcpClient.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

await initMCP();

// Convert MCP tools → Gemini function declarations
function getGeminiTools() {
  return [{
    functionDeclarations: getMCPTools().map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }))
  }];
}

app.get("/health", (_, res) => res.json({
  status: "ok",
  provider: "Google Gemini Flash",
  tools: getMCPTools().map((t: any) => t.name)
}));

app.post("/chat", async (req, res) => {
  const { messages } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // Convert messages to Gemini format
    // Gemini uses "user"/"model" roles (not "assistant")
    const geminiHistory = messages.slice(0, -1).map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));

    const lastMessage = messages[messages.length - 1].content;

    // Initialize model with MCP tools
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: `You are HealthX AI, a helpful assistant with access to a MySQL database.
        Use the available tools to answer questions accurately.
        Always explain what you're doing when querying the database.`,
      tools: getMCPTools().length > 0 ? getGeminiTools() : undefined,
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingMode.AUTO }
      }
    });

    // Start chat with history
    const chat = model.startChat({ history: geminiHistory });

    // Agentic loop — handles tool calls
    let userInput = lastMessage;

    while (true) {
      const result = await chat.sendMessageStream(userInput);

      let fullText = "";
      let functionCalls: any[] = [];

      // Stream text chunks to frontend
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          fullText += text;
          send({ type: "text", content: text });
        }

        // Detect function calls
        const calls = chunk.functionCalls();
        if (calls && calls.length > 0) {
          functionCalls.push(...calls);
        }
      }

      const response = await result.response;
      const allFunctionCalls = response.functionCalls();

      // No tool calls — done
      if (!allFunctionCalls || allFunctionCalls.length === 0) {
        send({ type: "done" });
        break;
      }

      // Execute each tool call via MCP
      const functionResponses = [];
      for (const call of allFunctionCalls) {
        try {
          send({ type: "tool_start", tool: call.name });
          send({ type: "tool_running", tool: call.name, input: call.args });

          const result = await callMCPTool(call.name, call.args);
          send({ type: "tool_result", tool: call.name, result });

          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { result: JSON.stringify(result) }
            }
          });
        } catch (err: any) {
          functionResponses.push({
            functionResponse: {
              name: call.name,
              response: { error: err.message }
            }
          });
        }
      }

      // Feed tool results back — continue loop
      userInput = functionResponses as any;
    }

  } catch (err: any) {
    send({ type: "error", message: err.message });
    res.end();
  }
});

app.listen(process.env.PORT || 3001, () => {
  console.log(`🚀 HealthX backend running on port ${process.env.PORT || 3001}`);
  console.log(`🤖 Provider: Google Gemini 1.5 Flash (Free)`);
});
