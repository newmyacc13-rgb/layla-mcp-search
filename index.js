import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app = express();
const port = process.env.PORT || 3000;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const LAYLA_SECRET = process.env.LAYLA_SECRET || 'layla123';

// نظام المصادقة
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${LAYLA_SECRET}`) {
    return res.status(401).send('Unauthorized: You are not Layla!');
  }
  next();
});

// إنشاء خادم MCP
const server = new Server(
  { name: 'layla-brave-search', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// تعريف أداة البحث
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

// تنفيذ البحث
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'brave_web_search') {
    const query = request.params.arguments.query;
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
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

// ربط MCP - (الجزء اللي اتعدل عشان يرضي تطبيق Layla)
let transport;
app.get('/sse', async (req, res) => {
  transport = new SSEServerTransport('/sse', res); 
  await server.connect(transport);
});

app.post('/sse', express.json(), async (req, res) => { 
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send('Connection not ready');
  }
});

app.listen(port, () => console.log(`Layla MCP Server running on port ${port}`));
