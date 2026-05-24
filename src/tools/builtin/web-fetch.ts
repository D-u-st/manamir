// Web Fetch tool: fetch a URL and return content with HTML stripped

import { buildTool } from '../build-tool';
import type { ToolDefinition } from '../types';

const MAX_BODY_LENGTH = 100_000; // 100KB text limit

/** Strip HTML tags and decode common entities, keeping readable text */
function stripHtml(html: string): string {
  let text = html;

  // Remove script/style blocks entirely
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Replace <br>, <p>, <div>, <li>, <tr>, headings with newlines
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|section|article)>/gi, '\n');

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&\w+;/g, ''); // drop unrecognized entities

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

export const webFetchTool: ToolDefinition = buildTool({
  name: 'web_fetch',
  description: 'Fetch any URL and return its content. THIS GIVES YOU FULL INTERNET ACCESS. Call this tool whenever the user asks you to read, fetch, look at, or summarize ANY web page (papers, GitHub, docs, news, blog posts, anything with a URL). HTML is auto-stripped to plain text. NEVER tell the user "I cannot access the internet" or "use curl yourself" — call this tool instead. Required: url. Optional: raw (skip HTML strip), headers.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      raw: { type: 'boolean', description: 'If true, return raw response without HTML stripping (default false)' },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers to send',
        additionalProperties: { type: 'string' }
      }
    },
    required: ['url']
  },
  readonly: true,
  category: 'web',

  async execute(input) {
    const url = input.url as string;
    const raw = (input.raw as boolean) ?? false;
    const extraHeaders = (input.headers as Record<string, string>) ?? {};

    // Basic URL validation
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { content: `Invalid URL: ${url}`, isError: true };
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { content: `Only http/https URLs are supported, got: ${parsed.protocol}`, isError: true };
    }

    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Manamir/2.0 (AI Agent)',
          'Accept': 'text/html, application/json, text/plain, */*',
          ...extraHeaders
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000)
      });

      const contentType = resp.headers.get('content-type') ?? '';
      const statusLine = `HTTP ${resp.status} ${resp.statusText}`;

      if (!resp.ok) {
        const body = await resp.text();
        const preview = body.slice(0, 2000);
        return { content: `${statusLine}\n\n${preview}`, isError: true };
      }

      let body = await resp.text();

      if (body.length > MAX_BODY_LENGTH) {
        body = body.slice(0, MAX_BODY_LENGTH) + `\n\n[Truncated at ${MAX_BODY_LENGTH} characters]`;
      }

      // Strip HTML unless raw mode or non-HTML content type
      const isHtml = contentType.includes('html');
      if (isHtml && !raw) {
        body = stripHtml(body);
      }

      return { content: `${statusLine}\nContent-Type: ${contentType}\n\n${body}`, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Fetch failed: ${msg}`, isError: true };
    }
  }
}, { timeoutMs: 20_000 });
