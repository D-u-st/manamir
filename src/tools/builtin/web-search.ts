// Web Search tool: search the web via DuckDuckGo HTML endpoint

import { buildTool } from '../build-tool';
import type { ToolDefinition } from '../types';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Parse DuckDuckGo HTML search results page */
function parseDdgResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results are in <a class="result__a" ...> tags
  // with snippets in <a class="result__snippet" ...> tags
  // We use two strategies to be resilient to minor layout changes

  // Strategy 1: match result blocks via result__a links
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links: { url: string; title: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').trim();

    // DuckDuckGo wraps URLs through a redirect; extract the actual URL
    let url = rawUrl;
    const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    if (title && url) {
      links.push({ url, title });
    }
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    const snippet = match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
    snippets.push(snippet);
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] ?? ''
    });
  }

  // Strategy 2 fallback: if no results from class-based parsing, try generic link extraction
  if (results.length === 0) {
    const genericRegex = /<a[^>]*href="(https?:\/\/(?!duckduckgo)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const seen = new Set<string>();
    while ((match = genericRegex.exec(html)) !== null && results.length < 10) {
      const url = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (title && title.length > 3 && !seen.has(url)) {
        seen.add(url);
        results.push({ title, url, snippet: '' });
      }
    }
  }

  return results;
}

export const webSearchTool: ToolDefinition = buildTool({
  name: 'web_search',
  description: 'Search the web (DuckDuckGo). THIS GIVES YOU INTERNET SEARCH. Call this whenever the user asks for current info, latest news, recent papers, or anything you might not know. Returns top results with title, URL, snippet. NEVER tell the user "I do not have internet" — call this tool. After getting results, use web_fetch on the most relevant URL to read full content.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'number', description: 'Max results to return (default 10)' }
    },
    required: ['query']
  },
  readonly: true,
  category: 'web',

  async execute(input) {
    const query = input.query as string;
    const maxResults = (input.max_results as number) || 10;

    const params = new URLSearchParams({ q: query });
    const url = `https://html.duckduckgo.com/html/?${params.toString()}`;

    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Manamir/2.0 (AI Agent)',
          'Accept': 'text/html'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000)
      });

      if (!resp.ok) {
        return { content: `Search failed: HTTP ${resp.status} ${resp.statusText}`, isError: true };
      }

      const html = await resp.text();
      const results = parseDdgResults(html).slice(0, maxResults);

      if (results.length === 0) {
        return { content: 'No search results found.', isError: false };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`
      ).join('\n\n');

      return { content: `Found ${results.length} results:\n\n${formatted}`, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Search failed: ${msg}`, isError: true };
    }
  }
}, { timeoutMs: 15_000 });
