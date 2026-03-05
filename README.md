# HealthX Chat MCP

A Claude-like chat UI connected to MySQL via MCP (Model Context Protocol).

## Stack
- **Frontend**: React + TypeScript + Nginx
- **Backend**: Express + TypeScript + Anthropic SDK
- **MCP**: MySQL server (query, execute, list_tables, describe_table)
- **DB**: MySQL 8.0
- **Infra**: Docker + Docker Compose

---

## 🐳 Run with Docker (Recommended)

```bash
# 1. Clone the repo
git clone https://github.com/Davidking369/healthx-chat-mcp.git
cd healthx-chat-mcp

# 2. Setup environment
cp .env.example .env
# Edit .env and fill in your ANTHROPIC_API_KEY

# 3. Build and start
docker-compose up -d --build

# 4. Open
open http://localhost:3000
```

---

## 💻 Run Locally (Without Docker)

### Backend
```bash
cd backend
npm install
cp .env.example .env   # fill in credentials
npx ts-node index.ts
```

### Frontend
```bash
cd frontend
npm install
npm start
```

---

## 🔑 Required Credentials

| Key | Description | Get it from |
|-----|-------------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key | https://console.anthropic.com |
| `MYSQL_HOST` | DB host | Your DB provider |
| `MYSQL_USER` | DB username | Your DB provider |
| `MYSQL_PASSWORD` | DB password | Your DB provider |
| `MYSQL_DATABASE` | DB name | Your DB provider |

---

## 🐳 Docker Commands

```bash
# Start
docker-compose up -d

# Stop
docker-compose down

# Rebuild after changes
docker-compose up -d --build

# View logs
docker-compose logs -f backend

# Fresh start (wipes DB)
docker-compose down -v
```

---

## ✅ Features
- Streaming responses
- Tool call visibility (see exactly what MCP tools ran)
- MySQL MCP integration (query, execute, list tables, describe)
- Dark theme UI
- Markdown rendering
- Docker ready
