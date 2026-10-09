import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const port = process.env.PORT || 3000;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', '*');
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

let transport;

// المسار الأول: فتح الاتصال
app.get('/sse', async (req, res) => {
  // السيرفر بيبلغ التطبيق إنه يبعت الأوامر على مسار /messages
  transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

// المسار الثاني: استقبال الأوامر 
app.post('/messages', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== 'Bearer Lovely333') {
    return res.status(401).send('Unauthorized');
  }
  
  if (!transport) {
    return res.status(400).send('Connection not ready');
  }
  
  await transport.handlePostMessage(req, res);
});

app.listen(port, () => console.log(`Server running on port ${port}`));
