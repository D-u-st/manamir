// Think block filter — strips <think>, <REASONING_SCRATCHPAD>, <reasoning> from streamed text
// State machine: NORMAL → IN_THINK (on opening tag) → NORMAL (on closing tag)
// Buffers partial tags to avoid false positives

type FilterState = 'NORMAL' | 'IN_THINK' | 'MAYBE_OPEN' | 'MAYBE_CLOSE';

const THINK_TAGS = ['think', 'REASONING_SCRATCHPAD', 'reasoning'] as const;
const OPEN_PATTERNS = THINK_TAGS.map(t => `<${t}>`);
const CLOSE_PATTERNS = THINK_TAGS.map(t => `</${t}>`);

export class ThinkFilter {
  private state: FilterState = 'NORMAL';
  private buffer = '';
  private activeTag: string | null = null;
  reasoning = '';

  feed(chunk: string): string {
    let output = '';
    let i = 0;

    while (i < chunk.length) {
      const ch = chunk[i];

      switch (this.state) {
        case 'NORMAL':
          if (ch === '<') {
            this.buffer = '<';
            this.state = 'MAYBE_OPEN';
          } else {
            output += ch;
          }
          break;

        case 'MAYBE_OPEN':
          this.buffer += ch;
          if (ch === '>') {
            const matched = this.matchOpenTag(this.buffer);
            if (matched) {
              this.state = 'IN_THINK';
              this.activeTag = matched;
              this.buffer = '';
            } else {
              output += this.buffer;
              this.buffer = '';
              this.state = 'NORMAL';
            }
          } else if (this.buffer.length > 30) {
            output += this.buffer;
            this.buffer = '';
            this.state = 'NORMAL';
          } else if (!this.couldMatchAnyTag(this.buffer)) {
            output += this.buffer;
            this.buffer = '';
            this.state = 'NORMAL';
          }
          break;

        case 'IN_THINK':
          if (ch === '<') {
            this.reasoning += this.buffer;
            this.buffer = '<';
            this.state = 'MAYBE_CLOSE';
          } else {
            this.buffer += ch;
          }
          break;

        case 'MAYBE_CLOSE':
          // Defensive: if activeTag is somehow null here, the state machine is corrupted.
          // Reset to NORMAL and re-emit any buffered content rather than crashing.
          if (!this.activeTag) {
            output += this.buffer;
            this.buffer = '';
            this.state = 'NORMAL';
            break;
          }
          this.buffer += ch;
          if (ch === '>') {
            if (this.matchCloseTag(this.buffer, this.activeTag)) {
              this.state = 'NORMAL';
              this.activeTag = null;
              this.buffer = '';
            } else {
              this.reasoning += this.buffer;
              this.buffer = '';
              this.state = 'IN_THINK';
            }
          } else if (this.buffer.length > 30) {
            this.reasoning += this.buffer;
            this.buffer = '';
            this.state = 'IN_THINK';
          }
          break;
      }
      i++;
    }

    return output;
  }

  flush(): string {
    if (this.state === 'MAYBE_OPEN') {
      const out = this.buffer;
      this.buffer = '';
      this.state = 'NORMAL';
      return out;
    }
    if (this.state === 'IN_THINK' || this.state === 'MAYBE_CLOSE') {
      this.reasoning += this.buffer;
      this.buffer = '';
      this.state = 'NORMAL';
    }
    return '';
  }

  reset(): void {
    this.state = 'NORMAL';
    this.buffer = '';
    this.activeTag = null;
    this.reasoning = '';
  }

  private matchOpenTag(buf: string): string | null {
    for (let i = 0; i < THINK_TAGS.length; i++) {
      if (buf === OPEN_PATTERNS[i]) return THINK_TAGS[i];
    }
    return null;
  }

  private matchCloseTag(buf: string, tag: string): boolean {
    return buf === `</${tag}>`;
  }

  private couldMatchAnyTag(partial: string): boolean {
    for (const pattern of OPEN_PATTERNS) {
      if (pattern.startsWith(partial)) return true;
    }
    for (const pattern of CLOSE_PATTERNS) {
      if (pattern.startsWith(partial)) return true;
    }
    return false;
  }
}
