// Gate Chain cheapest-first (P-13) — short-circuit async checks before spawning executor
import { log } from '../utils/logger';

export interface Gate {
  name: string;
  check: () => Promise<boolean>;
}

export interface GateResult {
  passed: boolean;
  failedGate: string | null;
  checkedCount: number;
  durationMs: number;
}

export class GateChain {
  private gates: Gate[] = [];

  /** Add a gate. Gates run in insertion order — add cheapest checks first. */
  add(name: string, check: () => Promise<boolean>): this {
    this.gates.push({ name, check });
    return this;
  }

  /** Remove a gate by name */
  remove(name: string): this {
    this.gates = this.gates.filter(g => g.name !== name);
    return this;
  }

  /** Run all gates in order. Short-circuits on first failure. */
  async run(): Promise<GateResult> {
    const start = Date.now();
    let checked = 0;

    for (const gate of this.gates) {
      checked++;
      try {
        const ok = await gate.check();
        if (!ok) {
          log.info(`Gate "${gate.name}" blocked execution`, { checked, total: this.gates.length });
          return {
            passed: false,
            failedGate: gate.name,
            checkedCount: checked,
            durationMs: Date.now() - start
          };
        }
      } catch (err) {
        log.error(`Gate "${gate.name}" threw`, { error: String(err) });
        return {
          passed: false,
          failedGate: gate.name,
          checkedCount: checked,
          durationMs: Date.now() - start
        };
      }
    }

    return {
      passed: true,
      failedGate: null,
      checkedCount: checked,
      durationMs: Date.now() - start
    };
  }

  /** Get the list of gate names in order */
  list(): string[] {
    return this.gates.map(g => g.name);
  }
}
