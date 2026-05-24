// moa_query tool — multi-perspective answer via Mixture of Agents

import { MixtureOfAgents, type MoaConfig, type MoaModelEndpoint } from '../../agents/moa';
import { buildTool } from '../build-tool';
import { log } from '../../utils/logger';
import type { ToolDefinition } from '../types';

let moaInstance: MixtureOfAgents | null = null;

export function initMoaTool(config: Partial<MoaConfig> & Pick<MoaConfig, 'referenceModels' | 'aggregatorModel'>): void {
  moaInstance = new MixtureOfAgents(config);
  log.info('moa_query tool initialized', {
    referenceModels: config.referenceModels.map(m => m.model),
    aggregator: config.aggregatorModel.model
  });
}

export const moaQueryTool: ToolDefinition = buildTool({
  name: 'moa_query',
  description: 'Get a multi-perspective answer by running the query through multiple AI models and synthesizing their responses. Use when you want higher-quality or more reliable answers.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The question or prompt to send to multiple models'
      },
      system_prompt: {
        type: 'string',
        description: 'Optional system prompt for all models'
      }
    },
    required: ['query']
  },
  readonly: true,
  category: 'system',

  async execute(input) {
    if (!moaInstance) {
      return {
        content: 'MoA not configured. Call initMoaTool() with model endpoints first.',
        isError: true
      };
    }

    const query = input.query as string;
    const systemPrompt = input.system_prompt as string | undefined;

    try {
      const result = await moaInstance.execute(query, systemPrompt);
      return { content: result, isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `MoA failed: ${msg}`, isError: true };
    }
  }
}, { timeoutMs: 120_000 });
