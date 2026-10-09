import express from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const port = process.env.PORT || 3000;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const MCP_API_KEY = process.env.MCP_API_KEY; // نفس القيمة اللي بتكتبها في خانة Bearer Auth في التطبيق

if (!BRAVE_API_KEY) console.warn('⚠️ BRAVE_API_KEY غير موجود في Environment Variables');
if (!MCP_API_KEY) console.warn('⚠️ MCP_API_KEY غير موجود — السيرفر مفتوح بدون حماية!');

// ---------- CORS ----------
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
  res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Auth (على كل المسارات) ----------
function auth(req, res, next) {
  if (!MCP_API_KEY) return next();
  if (req.headers.authorization !== `Bearer ${MCP_API_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------- MCP server factory (سيرفر جديد لكل اتصال) ----------
function createMcpServer() {
  const server = new Server(
    { name: 'layla-brave-search', version: '1.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'brave_web_search',
      description: 'Search the web for real-time info, news, and code documentation.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query' } },
        required: ['query']
      }
    }]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'brave_web_search') throw new Error('Tool not found');
    try {
      const query = request.params.arguments?.query;
      if (!query) throw new Error('query is required');
      if (!BRAVE_API_KEY) throw new Error('BRAVE_API_KEY is not set on the server');

      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
        { headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_API_KEY } }
      );
      if (!res.ok) throw new Error(`Brave API error: ${res.status}`);
      const data = await res.json();
      const results = data.web?.results
        ?.map(r => `[${r.title}](${r.url})\n${r.description}`)
        .join('\n\n---\n\n');
      return { content: [{ type: 'text', text: results || 'No results found.' }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] };
    }
  });

  return server;
}

// ---------- Health check ----------
app.get('/', (req, res) => res.send('MCP server is running'));

// ---------- 1) Streamable HTTP (الحديث) — Layla بتبعت POST على /sse وبتطلب Mcp-Session-Id ----------
const httpSessions = new Map(); // sessionId -> transport

async function handleStreamable(req, res) {
  try {
    const sid = req.headers['mcp-session-id'];
    let transport = sid ? httpSessions.get(sid) : undefined;

    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        // جلسة غير معروفة (مثلاً السيرفر عمل restart) -> 404 عشان العميل يبدأ جلسة جديدة
        return res.status(sid ? 404 : 400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: sid ? 'Session not found' : 'Bad Request: no session' },
          id: null
        });
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { httpSessions.set(id, transport); }
      });
      transport.onclose = () => {
        if (transport.sessionId) httpSessions.delete(transport.sessionId);
      };
      await createMcpServer().connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('Streamable error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}

async function handleSessionRequest(req, res) {
  const transport = httpSessions.get(req.headers['mcp-session-id']);
  if (!transport) return res.status(404).send('Session not found');
  await transport.handleRequest(req, res);
}

app.post(['/sse', '/mcp'], auth, express.json(), handleStreamable);
app.get('/mcp', auth, handleSessionRequest);
app.delete(['/sse', '/mcp'], auth, handleSessionRequest);

// ---------- 2) SSE القديم (للتوافق) ----------
const sseTransports = new Map(); // sessionId -> transport

app.get('/sse', auth, async (req, res) => {
  if (req.headers['mcp-session-id']) return handleSessionRequest(req, res);
  const transport = new SSEServerTransport('/messages', res);
  sseTransports.set(transport.sessionId, transport);
  res.on('close', () => sseTransports.delete(transport.sessionId));
  const server = createMcpServer();
  await server.connect(transport);
});

app.post('/messages', auth, async (req, res) => {
  const transport = sseTransports.get(req.query.sessionId);
  if (!transport) return res.status(400).send('No transport found for sessionId');
  await transport.handlePostMessage(req, res); // مهم: من غير express.json هنا
});

app.listen(port, () => console.log(`Server running on port ${port}`));
