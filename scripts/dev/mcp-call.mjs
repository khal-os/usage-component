#!/usr/bin/env node
/**
 * DEV ONLY — the smallest MCP client that can drive this endpoint, using the
 * OFFICIAL SDK (the same one the contract suite uses), so a workstation check
 * exercises the real protocol instead of a hand-rolled POST.
 *
 *   MCP_URL=http://localhost:3010/mcp MCP_TOKEN=<jwt> node scripts/dev/mcp-call.mjs
 *   … node scripts/dev/mcp-call.mjs get_overview
 *   … node scripts/dev/mcp-call.mjs list_traces '{"page_size":3}'
 *   … node scripts/dev/mcp-call.mjs prompts | prompt close-month '{"year":"2026","month":"6"}'
 *   … node scripts/dev/mcp-call.mjs resources | resource usage://prices
 *   … node scripts/dev/mcp-call.mjs discover
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { z } = require('zod');

const [command, first, second] = process.argv.slice(2);
const url = process.env.MCP_URL ?? 'http://localhost:3000/mcp';
const token = process.env.MCP_TOKEN ?? '';

if (!token) {
  console.error('set MCP_TOKEN (scripts/dev/mcp-stub-issuer.mjs prints one)');
  process.exit(1);
}

const show = (value) =>
  console.log(
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  );

const client = new Client({ name: 'usage-mcp-dev-cli', version: '1.0.0' });

await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

const parsed = (raw) => (raw ? JSON.parse(raw) : {});

try {
  if (!command) {
    const { tools } = await client.listTools();
    show(
      tools
        .map((tool) => `${tool.name} — ${tool.description.split('. ')[0]}`)
        .join('\n'),
    );
  } else if (command === 'prompts') {
    const { prompts } = await client.listPrompts();
    show(
      prompts
        .map((prompt) => `${prompt.name} — ${prompt.description}`)
        .join('\n'),
    );
  } else if (command === 'prompt') {
    const result = await client.getPrompt({
      name: first,
      arguments: parsed(second),
    });
    show(result.messages.map((message) => message.content.text).join('\n\n'));
  } else if (command === 'resources') {
    const { resources } = await client.listResources();
    show(
      resources
        .map((resource) => `${resource.uri} — ${resource.title}`)
        .join('\n'),
    );
  } else if (command === 'resource') {
    const result = await client.readResource({ uri: first });
    for (const content of result.contents) show(content.text ?? content);
  } else if (command === 'discover') {
    show(
      await client.request(
        { method: 'server/discover', params: {} },
        z.object({}).passthrough(),
      ),
    );
  } else {
    const result = await client.callTool({
      name: command,
      arguments: parsed(first),
    });
    show(result.structuredContent ?? result.content);
    if (result.isError) process.exitCode = 1;
  }
} finally {
  await client.close();
}
