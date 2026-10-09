import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const port = process.env.PORT || 3000;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const LAYLA_SECRET = process.env.LAYLA_SECRET || 'layla123';

// 1. السماح بالاتصالات بدون قيود
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const server = new Server(
  { name: 'layla-brave-search', version: '1.0.0' },
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
  if (request.params.name === 'brave_web_search') {
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(request.params.arguments.query)}`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_API_KEY }
      });
      if (!res.ok) throw new Error(`Brave API error: ${res.status}`);
      const data = await res.json();
      const results = data.web?.results?.map(r => `[${r.title}](${r.url})\n${r.description}`).join('\n\n---\n\n');
      return { content: [{ type: 'text', text: results || 'No results found.' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
    }
  }
  throw new Error('Tool not found');
});

// نظام الجلسات المتعددة لتفادي سقوط السيرفر
const transports = new Map();

// 2. إنشاء قناة الاتصال وإرسال الرابط الكامل للتطبيق
app.get(['/', '/sse'], async (req, res) => {
  try {
    const sessionId = Math.random().toString(36).substring(7);
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    
    // إجبار التطبيق على استخدام مسار صريح وكامل
    const endpoint = `${protocol}://${host}/message?sessionId=${sessionId}`;
    
    const transport = new SSEServerTransport(endpoint, res);
    transports.set(sessionId, transport);
    
    await server.connect(transport);
    
    res.on('close', () => {
      transports.delete(sessionId);
    });
  } catch (error) {
    console.error('SSE connection error:', error);
  }
});

// 3. استقبال الأوامر (بدون express.json عشان السيرفر ميعملش ريستارت)
app.post(['/message', '/sse'], async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${LAYLA_SECRET}`) {
      return res.status(401).send('Unauthorized');
    }

    const sessionId = req.query.sessionId;
    let transport = transports.get(sessionId);

    // خطة بديلة لو التطبيق اتلخبط في الرابط
    if (!transport && transports.size === 1) {
      transport = Array.from(transports.values())[0];
    }

    if (!transport) {
      return res.status(400).send('Connection not ready. Try Discover Tools again.');
    }

    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error('Message error:', error);
    res.status(500).send('Internal Error');
  }
});

app.listen(port, () => console.log(`Layla MCP Server running on port ${port}`));
