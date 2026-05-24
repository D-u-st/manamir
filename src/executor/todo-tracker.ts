// Todo Tracker — extracts and tracks open todos from conversation messages so
// they can be re-injected after context compression (which often summarizes
// pending todos away, causing the agent to forget commitments).
//
// No Bun APIs. ES modules.

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  turnAdded: number;
}

// ── Extraction patterns ──
//
// We support several syntactic forms users commonly use:
//   - "TODO: <text>" / "todo: <text>" (case insensitive, allow leading punctuation)
//   - "- [ ] <text>" / "- [x] <text>" (Markdown checkbox; x => done)
//   - "待办：<text>" / "待办: <text>" (Chinese, full-width or half-width colon)
//   - "需要做：<text>" / "需要做: <text>" (Chinese)
//
// Each pattern's first capture group is the todo text; checkbox pattern has a
// dedicated state group.

interface ExtractedHit {
  text: string;
  done: boolean;
}

function extractHits(content: string): ExtractedHit[] {
  const hits: ExtractedHit[] = [];

  // Markdown checkbox: capture state + text. Multi-line, case-insensitive on x.
  const checkboxRe = /^[ \t]*[-*+][ \t]+\[([ xX])\][ \t]+(.+?)[ \t]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = checkboxRe.exec(content)) !== null) {
    const state = m[1].toLowerCase();
    const text = m[2].trim();
    if (text.length === 0) continue;
    hits.push({ text, done: state === 'x' });
  }

  // English TODO: / todo: — case insensitive. Match whole-line up to newline.
  // Allow leading punctuation (e.g., "- TODO: foo", "* todo: bar").
  const todoRe = /(?:^|[\s>*\-+#])todo\s*[:：][ \t]*(.+?)(?:$|\n)/gim;
  while ((m = todoRe.exec(content)) !== null) {
    const text = m[1].trim();
    if (text.length === 0) continue;
    hits.push({ text, done: false });
  }

  // Chinese: 待办: / 待办：
  const daibanRe = /待办[\s]*[:：][ \t]*(.+?)(?:$|\n)/gm;
  while ((m = daibanRe.exec(content)) !== null) {
    const text = m[1].trim();
    if (text.length === 0) continue;
    hits.push({ text, done: false });
  }

  // Chinese: 需要做: / 需要做：
  const xuyaoRe = /需要做[\s]*[:：][ \t]*(.+?)(?:$|\n)/gm;
  while ((m = xuyaoRe.exec(content)) !== null) {
    const text = m[1].trim();
    if (text.length === 0) continue;
    hits.push({ text, done: false });
  }

  return hits;
}

function makeId(text: string, turn: number, salt: number): string {
  // Deterministic-ish but unique enough; not security sensitive.
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return `todo_${turn}_${(h >>> 0).toString(36)}_${salt.toString(36)}`;
}

export class TodoTracker {
  private todos: Todo[] = [];
  private counter = 0;

  /**
   * Extract todos from a single message. New (open) hits are added to the
   * tracker; checkbox hits with state "x" mark matching open todos done.
   * Returns the list of newly-extracted Todo records (open + done) that the
   * caller may want to log.
   */
  extractFromMessage(content: string, turn: number): Todo[] {
    if (!content) return [];
    const hits = extractHits(content);
    const created: Todo[] = [];
    const now = Date.now();

    for (const hit of hits) {
      if (hit.done) {
        // A "- [x] foo" entry — treat as a completion signal. If we already
        // track an open todo with matching text, mark it done. Otherwise add
        // it as a done todo for the historical record.
        const existing = this.todos.find(t => !t.done && this.textMatches(t.text, hit.text));
        if (existing) {
          existing.done = true;
          created.push(existing);
        } else {
          const todo: Todo = {
            id: makeId(hit.text, turn, ++this.counter),
            text: hit.text,
            done: true,
            createdAt: now,
            turnAdded: turn
          };
          this.todos.push(todo);
          created.push(todo);
        }
        continue;
      }

      // Skip exact-text duplicates of existing open todos (avoid spamming the
      // same todo every turn it's referenced).
      if (this.todos.some(t => !t.done && t.text === hit.text)) continue;

      const todo: Todo = {
        id: makeId(hit.text, turn, ++this.counter),
        text: hit.text,
        done: false,
        createdAt: now,
        turnAdded: turn
      };
      this.todos.push(todo);
      created.push(todo);
    }

    return created;
  }

  /** Get all open (not-done) todos, in insertion order. */
  getOpen(): Todo[] {
    return this.todos.filter(t => !t.done);
  }

  /** Get every todo the tracker has seen. */
  getAll(): Todo[] {
    return [...this.todos];
  }

  /**
   * Mark a todo done. If `idOrText` matches an existing id exactly, that one
   * is marked. Otherwise we look for an open todo whose text starts with
   * `idOrText` (case-insensitive prefix match). Returns true on success.
   */
  markDone(idOrText: string): boolean {
    if (!idOrText) return false;

    const byId = this.todos.find(t => t.id === idOrText);
    if (byId) {
      if (byId.done) return false;
      byId.done = true;
      return true;
    }

    const needle = idOrText.toLowerCase();
    const byText = this.todos.find(t => !t.done && this.textMatches(t.text, needle));
    if (byText) {
      byText.done = true;
      return true;
    }
    return false;
  }

  /**
   * Format open todos as an XML block suitable for prompt injection. Returns
   * an empty string when nothing is open, so callers can safely concatenate.
   */
  formatForInjection(): string {
    const open = this.getOpen();
    if (open.length === 0) return '';
    const lines = open.map(t => `- ${t.text}`).join('\n');
    return `<pending-todos count="${open.length}">\n${lines}\n</pending-todos>`;
  }

  /** Reset all tracked todos. */
  clear(): void {
    this.todos = [];
    this.counter = 0;
  }

  // ── Internals ──

  private textMatches(stored: string, needle: string): boolean {
    const a = stored.toLowerCase().trim();
    const b = needle.toLowerCase().trim();
    if (a === b) return true;
    // Prefix match — e.g., markDone("fix build") matches "fix build asap".
    if (a.startsWith(b) || b.startsWith(a)) return true;
    return false;
  }
}
