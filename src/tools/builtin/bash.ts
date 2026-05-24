// Bash tool: execute shell commands via child_process.spawn

import { spawn } from 'child_process';
import { buildTool } from '../build-tool';
import { checkCommandPolicy } from '../policy';
import type { ToolDefinition } from '../types';

export const bashTool: ToolDefinition = buildTool({
  name: 'bash',
  description: 'Execute a shell command and return stdout/stderr.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000)' },
    },
    required: ['command'],
  },
  readonly: false,
  category: 'system',

  async execute(input) {
    const command = input.command as string;
    const cwd = (input.cwd as string) || process.cwd();
    const timeout = (input.timeout as number) || 30_000;

    const violation = checkCommandPolicy('bash', command);
    if (violation) {
      return { content: `Policy violation: ${violation.reason}`, isError: true };
    }

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const proc = spawn('bash', ['-c', command], {
        cwd,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

      proc.on('close', (code) => {
        const stdout = Buffer.concat(chunks).toString('utf-8');
        const stderr = Buffer.concat(errChunks).toString('utf-8');
        const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');

        resolve({
          content: output || `(process exited with code ${code})`,
          isError: code !== 0,
        });
      });

      proc.on('error', (err) => {
        resolve({ content: `Spawn error: ${err.message}`, isError: true });
      });
    });
  },
}, { timeoutMs: 120_000 }); // bash gets a longer outer timeout
