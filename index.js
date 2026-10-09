import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

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

// ---------- 1) Streamable HTTP (الحديث) — ده اللي تطبيق Layla بيستخدمه: POST على /sse ----------
async function handleStreamable(req, res) {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); // stateless
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('Streamable error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}
app.post(['/sse', '/mcp'], auth, express.json(), handleStreamable);

// ---------- 2) SSE القديم (للتوافق) ----------
const sseTransports = new Map(); // sessionId -> transport

app.get('/sse', auth, async (req, res) => {
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

// /mcp لا يدعم GET/DELETE في الوضع stateless
app.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST').send('Method not allowed'));

app.listen(port, () => console.log(`Server running on port ${port}`));
