import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const port = process.env.PORT || 3000;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const LAYLA_SECRET = process.env.LAYLA_SECRET || 'Lovely333';

// السماح بالاتصال من التطبيق بدون قيود
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

let globalTransport = null;

// استقبال الاتصال المبدئي
app.get('/sse', async (req, res) => {
  globalTransport = new SSEServerTransport('/sse', res);
  await server.connect(globalTransport);
  
  req.on('close', () => {
    globalTransport = null; // تنظيف الذاكرة لو التطبيق قفل
  });
});

// استقبال أوامر البحث
app.post('/sse', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${LAYLA_SECRET}`) {
    return res.status(401).send('Unauthorized');
  }

  // لو Layla بعتت الأمر بدون اتصال جديد، نطلب منها المحاولة تاني
  if (!globalTransport) {
    return res.status(503).send('Connection not ready. Please restart Layla app.');
  }

  try {
    await globalTransport.handlePostMessage(req, res);
  } catch (error) {
    console.error('Message error:', error);
  }
});

// رسالة ترحيبية للمتصفح عشان تتأكد إنه شغال
app.get('/', (req, res) => {
  res.send('<h2 style="color: green; text-align: center; margin-top: 50px;">✅ السيرفر يعمل بنجاح! ارجع لتطبيق Layla</h2>');
});

app.listen(port, () => console.log(`Layla MCP Server running on port ${port}`));
