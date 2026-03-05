# HealthX Chat MCP

A Claude-like chat UI connected to your MySQL database via MCP (Model Context Protocol).

## Stack
- **Frontend**: React + TypeScript
- **Backend**: Express + TypeScript + Anthropic SDK
- **MCP**: MySQL server (query, execute, list_tables, describe_table)

## Setup

### Backend
```bash
cd backend
npm install
cp .env.example .env   # fill in your keys
npx ts-node index.ts
```

### Frontend
```bash
cd frontend
npm install
npm start
```

Open `http://localhost:3000`

## Features
- ✅ Streaming responses
- ✅ Tool call visibility
- ✅ MySQL MCP integration
- ✅ Dark theme
- ✅ Markdown rendering
