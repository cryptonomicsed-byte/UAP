import type Database from 'better-sqlite3';
import { addMcpServer, McpConnectorError } from './mcp-connectors.js';
import type { McpCatalogEntry } from '../types.js';

// Adapted from Nod's app/transport separation, not its code or assets (Apache-2.0):
// https://github.com/n8n-io/nod/tree/9333d3be8ee0861cc967c66007a40f7cb2b7dc17/src/apps
// Ready entries passed initialize + tools/list without credentials. OAuth entries are
// discoverable but cannot be installed until UAP brokers a per-agent authorization.
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  { id: 'deepwiki', displayName: 'DeepWiki', category: 'Code', auth: 'none', url: 'https://mcp.deepwiki.com/mcp', description: 'Read and ask questions about documentation for public GitHub projects.' },
  { id: 'context7', displayName: 'Context7', category: 'Code', auth: 'optional_token', url: 'https://mcp.context7.com/mcp', description: 'Look up current library and framework documentation.' },
  { id: 'huggingface', displayName: 'Hugging Face', category: 'Research', auth: 'optional_token', url: 'https://huggingface.co/mcp', description: 'Discover models, datasets and Spaces on the Hub.' },
  { id: 'exa', displayName: 'Exa', category: 'Research', auth: 'none', url: 'https://mcp.exa.ai/mcp', description: 'Search the public web and read page content.' },
  { id: 'aws_knowledge', displayName: 'AWS Knowledge', category: 'Cloud', auth: 'none', url: 'https://knowledge-mcp.global.api.aws', description: 'Find AWS documentation and check regional service availability.' },
  { id: 'microsoft_learn', displayName: 'Microsoft Learn', category: 'Cloud', auth: 'none', url: 'https://learn.microsoft.com/api/mcp', description: 'Search official Microsoft documentation and code samples.' },
  { id: 'linear', displayName: 'Linear', category: 'Workspace', auth: 'oauth', url: 'https://mcp.linear.app/mcp', description: 'Work with issues and projects in your Linear workspace.' },
  { id: 'notion', displayName: 'Notion', category: 'Workspace', auth: 'oauth', url: 'https://mcp.notion.com/mcp', description: 'Find and work with pages in your Notion workspace.' },
];

export function installMcpPreset(db: Database.Database, botId: string, preset: McpCatalogEntry, token: unknown) {
  if (token !== undefined && (preset.auth !== 'optional_token' || typeof token !== 'string' || !/^[!-~]{1,2048}$/.test(token))) {
    throw new McpConnectorError('Enter only the provider token (no spaces or Bearer prefix), or leave it blank.');
  }
  return addMcpServer(db, botId, {
    name: preset.id, url: preset.url,
    headers: typeof token === 'string' ? { Authorization: `Bearer ${token}` } : undefined,
  });
}
