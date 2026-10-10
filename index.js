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

// ---------- مواقع الكود الموثوقة (بتتقدّم في نتايج search_code) ----------
const TRUSTED = [
  'developer.mozilla.org', 'nodejs.org', 'github.com', 'raw.githubusercontent.com',
  'stackoverflow.com', 'stackexchange.com', 'docs.python.org', 'pypi.org', 'npmjs.com',
  'expressjs.com', 'react.dev', 'nextjs.org', 'vuejs.org', 'angular.dev', 'typescriptlang.org',
  'tailwindcss.com', 'developer.android.com', 'kotlinlang.org', 'learn.microsoft.com',
  'go.dev', 'pkg.go.dev', 'doc.rust-lang.org', 'docs.rs', 'cppreference.com',
  'docs.docker.com', 'kubernetes.io', 'postgresql.org', 'sqlite.org', 'redis.io',
  'fastapi.tiangolo.com', 'flask.palletsprojects.com', 'djangoproject.com',
  'modelcontextprotocol.io', 'huggingface.co', 'pytorch.org', 'numpy.org', 'pandas.pydata.org',
  'web.dev', 'readthedocs.io', 'docs.oracle.com'
];
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const isTrusted = (u) => { const h = hostOf(u); return TRUSTED.some(d => h === d || h.endsWith('.' + d)); };

async function braveSearch(query, { count = 5, preferTrusted = false } = {}) {
  if (!BRAVE_API_KEY) throw new Error('BRAVE_API_KEY is not set on the server');
  const fetchCount = preferTrusted ? 20 : count;
  const res = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${fetchCount}`,
    { headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_API_KEY } }
  );
  if (!res.ok) throw new Error(`Brave API error: ${res.status}`);
  const data = await res.json();
  let items = data.web?.results || [];
  if (preferTrusted) {
    // المواقع الموثوقة الأول، وبعدين الباقي
    items = [...items.filter(r => isTrusted(r.url)), ...items.filter(r => !isTrusted(r.url))];
  }
  return items.slice(0, count)
    .map(r => `[${r.title}](${r.url})\n${(r.description || '').replace(/<[^>]+>/g, '').slice(0, 300)}`)
    .join('\n\n---\n\n');
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|nav|header|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|pre|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function readPage(url, maxChars = 6000) {
  const u = new URL(url);
  const h = u.hostname.toLowerCase();
  if (u.protocol !== 'https:') throw new Error('Only https URLs are allowed');
  if (h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':') || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new Error('This host is not allowed');
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; layla-mcp/1.1)', Accept: 'text/html,text/plain,text/markdown' },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`Page error: ${res.status}`);
  const finalHost = hostOf(res.url);
  if (finalHost === 'localhost' || /^[\d.]+$/.test(finalHost)) throw new Error('Redirect to a blocked host');
  const type = res.headers.get('content-type') || '';
  const raw = await res.text();
  const text = type.includes('html') ? htmlToText(raw) : raw;
  return text.length > maxChars ? text.slice(0, maxChars) + '\n\n[...truncated]' : text;
}

// ---------- MCP server factory (سيرفر جديد لكل اتصال) ----------
function createMcpServer() {
  const server = new Server(
    { name: 'layla-brave-search', version: '1.2.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_code',
        description: 'Search for programming help. Prefers official docs, GitHub, MDN, Stack Overflow. Use for any code question.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'Short English query with library name and version' } },
          required: ['query']
        }
      },
      {
        name: 'brave_web_search',
        description: 'General web search for news, facts, and non-code questions.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', description: 'The search query' } },
          required: ['query']
        }
      },
      {
        name: 'read_page',
        description: 'Read the text of a web page (docs, README, article) from a URL found in search results.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Full https URL' } },
          required: ['url']
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (name === 'search_code' || name === 'brave_web_search') {
        if (!args.query) throw new Error('query is required');
        const out = await braveSearch(args.query, { preferTrusted: name === 'search_code' });
        const today = new Date().toISOString().slice(0, 10);
return { content: [{ type: 'text', text: `Today's date: ${today}. These results are current; trust them over your memory.\n\n${out || 'No results found.'}` }] };
      }
      if (name === 'read_page') {
        if (!args.url) throw new Error('url is required');
        return { content: [{ type: 'text', text: await readPage(args.url) }] };
      }
      throw new Error('Tool not found');
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
