// MoA (Mixture of Agents) — multi-model aggregation
//
// Runs N reference models in parallel via Promise.allSettled, then 1 aggregator
// synthesizes the best answer. Tolerates partial failures (configurable minSuccessful).

import { log } from '../utils/logger';
import { withRetry } from '../utils/retry';

export interface MoaModelEndpoint {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface MoaConfig {
  referenceModels: MoaModelEndpoint[];
  aggregatorModel: MoaModelEndpoint;
  referenceTemp: number;
  aggregatorTemp: number;
  minSuccessful: number;
  timeoutMs: number;
}

const DEFAULT_CONFIG: Partial<MoaConfig> = {
  referenceTemp: 0.6,
  aggregatorTemp: 0.4,
  minSuccessful: 1,
  timeoutMs: 30_000
};

export class MixtureOfAgents {
  private readonly config: MoaConfig;

  constructor(config: Partial<MoaConfig> & Pick<MoaConfig, 'referenceModels' | 'aggregatorModel'>) {
    this.config = { ...DEFAULT_CONFIG, ...config } as MoaConfig;

    if (this.config.referenceModels.length === 0) {
      throw new Error('MoA requires at least 1 reference model');
    }
  }

  async execute(prompt: string, systemPrompt?: string): Promise<string> {
    const startTime = Date.now();

    log.info('MoA: starting', {
      referenceCount: this.config.referenceModels.length,
      aggregator: this.config.aggregatorModel.model
    });

    // Phase 1: Run all reference models in parallel
    const results = await Promise.allSettled(
      this.config.referenceModels.map((endpoint, idx) =>
        this.callModelWithRetry(endpoint, prompt, systemPrompt, this.config.referenceTemp, idx)
      )
    );

    const successful: { model: string; response: string }[] = [];
    const failed: { model: string; error: string }[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const model = this.config.referenceModels[i].model;
      if (r.status === 'fulfilled') {
        successful.push({ model, response: r.value });
      } else {
        const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        failed.push({ model, error: errMsg });
        log.warn('MoA: reference model failed', { model, error: errMsg });
      }
    }

    log.info('MoA: reference phase complete', {
      successful: successful.length,
      failed: failed.length,
      durationMs: Date.now() - startTime
    });

    if (successful.length < this.config.minSuccessful) {
      const failInfo = failed.map(f => `${f.model}: ${f.error}`).join('; ');
      throw new Error(
        `MoA: only ${successful.length}/${this.config.minSuccessful} models succeeded. Failures: ${failInfo}`
      );
    }

    // If only one model succeeded, return directly (no aggregation needed)
    if (successful.length === 1) {
      log.info('MoA: single model succeeded, skipping aggregation');
      return successful[0].response;
    }

    // Phase 2: Aggregator synthesizes
    const aggregatorPrompt = this.buildAggregatorPrompt(prompt, successful);
    const aggregatorSystem = systemPrompt
      ? `${systemPrompt}\n\nYou are also acting as an aggregator. Critically evaluate and synthesize the following model responses.`
      : 'You are an aggregator. Critically evaluate and synthesize the following model responses into one optimal answer.';

    const finalResponse = await this.callModelWithRetry(
      this.config.aggregatorModel,
      aggregatorPrompt,
      aggregatorSystem,
      this.config.aggregatorTemp,
      -1
    );

    log.info('MoA: completed', { totalDurationMs: Date.now() - startTime });
    return finalResponse;
  }

  private async callModelWithRetry(
    endpoint: MoaModelEndpoint,
    prompt: string,
    systemPrompt: string | undefined,
    temperature: number,
    modelIdx: number
  ): Promise<string> {
    return withRetry(
      () => this.callModel(endpoint, prompt, systemPrompt, temperature),
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 15_000,
        shouldRetry: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          // Don't retry auth errors
          if (msg.includes('401') || msg.includes('403')) return false;
          return true;
        }
      }
    );
  }

  private async callModel(
    endpoint: MoaModelEndpoint,
    prompt: string,
    systemPrompt: string | undefined,
    temperature: number
  ): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const body: Record<string, unknown> = {
      model: endpoint.model,
      messages,
      max_tokens: 4096,
      stream: false
    };

    // GPT models don't support custom temperature in some configurations
    const isGpt = endpoint.model.startsWith('gpt-') || endpoint.provider === 'openai';
    if (!isGpt) {
      body.temperature = temperature;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${endpoint.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from model');
      }

      return content;
    } finally {
      // Always clear the timeout AND abort the controller so the signal is
      // released even on early/successful resolution. Aborting after the fetch
      // has already settled is a no-op on the response, but ensures any
      // downstream listeners on controller.signal are cleaned up.
      clearTimeout(timeout);
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
  }

  private buildAggregatorPrompt(
    originalPrompt: string,
    responses: Array<{ model: string; response: string }>
  ): string {
    const numbered = responses.map((r, i) =>
      `## Response ${i + 1} (${r.model})\n${r.response}`
    ).join('\n\n---\n\n');

    return `# Original Question
${originalPrompt}

# Model Responses
${numbered}

# Instructions
Critically evaluate the responses above. Synthesize them into one optimal answer:
- Prefer responses backed by concrete evidence or reasoning
- If responses agree, produce a clean merged answer
- If they disagree, evaluate which is more likely correct
- Output ONLY the final synthesized answer`;
  }
}
