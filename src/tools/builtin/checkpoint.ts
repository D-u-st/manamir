// Checkpoint tool — shadow git snapshots for undo/restore.
//
// Uses GIT_DIR + GIT_WORK_TREE env vars so no .git directory pollutes the user's project.
// Checkpoint data lives in data/checkpoints/{sha256(workdir)[:16]}/.
// Actions: snapshot, restore, list, diff.

import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import { buildTool } from '../build-tool';
import { log } from '../../utils/logger';
import type { ToolDefinition } from '../types';

const EXEC_TIMEOUT = 30_000;
const MAX_FILE_COUNT = 50_000;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/;
const CHECKPOINT_BASE = resolve('data/checkpoints');

const CHECKPOINT_GITIGNORE = `node_modules/
.git/
__pycache__/
dist/
.env
.env.*
`;

export class ShadowCheckpoint {
  readonly checkpointDir: string;
  private readonly workDir: string;
  private turnSnapshots = new Set<string>();

  constructor(workDir: string) {
    this.workDir = resolve(workDir);
    const hash = createHash('sha256').update(this.workDir).digest('hex').slice(0, 16);
    this.checkpointDir = join(CHECKPOINT_BASE, hash);
  }

  private gitEnv(): Record<string, string> {
    return {
      ...process.env as Record<string, string>,
      GIT_DIR: join(this.checkpointDir, '.git'),
      GIT_WORK_TREE: this.workDir
    };
  }

  private git(cmd: string): string {
    try {
      return execSync(`git ${cmd}`, {
        cwd: this.workDir,
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT,
        env: this.gitEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch (err) {
      const error = err as { stderr?: string; message?: string };
      const msg = (error.stderr || error.message || String(err)).trim();
      throw new Error(`git ${cmd}: ${msg}`);
    }
  }

  private gitSafe(cmd: string): string | null {
    try {
      return this.git(cmd);
    } catch {
      return null;
    }
  }

  ensureRepo(): void {
    if (!existsSync(this.checkpointDir)) {
      mkdirSync(this.checkpointDir, { recursive: true });
    }

    const gitDir = join(this.checkpointDir, '.git');
    if (!existsSync(gitDir)) {
      log.info('ShadowCheckpoint: initializing shadow repo', {
        workDir: this.workDir,
        checkpointDir: this.checkpointDir
      });
      this.git('init');
      this.git('config user.email "manamir@checkpoint"');
      this.git('config user.name "Manamir Checkpoint"');

      // Write .gitignore in checkpoint dir
      const ignorePath = join(this.checkpointDir, '.gitignore');
      writeFileSync(ignorePath, CHECKPOINT_GITIGNORE, 'utf-8');

      // Initial commit
      this.git('add -A');
      this.git('commit --allow-empty -m "checkpoint: initial"');
    }
  }

  snapshot(message?: string): string {
    this.ensureRepo();

    // File count guard
    const fileCount = this.countFiles(this.workDir);
    if (fileCount > MAX_FILE_COUNT) {
      throw new Error(`Too many files (${fileCount} > ${MAX_FILE_COUNT}), skipping checkpoint`);
    }

    // Per-turn dedup
    const turnKey = this.workDir;
    if (this.turnSnapshots.has(turnKey)) {
      log.info('ShadowCheckpoint: already checkpointed this turn, skipping', { workDir: this.workDir });
      return this.git('rev-parse --short HEAD');
    }

    this.git('add -A');

    const status = this.gitSafe('status --porcelain');
    if (!status || status.length === 0) {
      log.info('ShadowCheckpoint: no changes to snapshot');
      return this.git('rev-parse --short HEAD');
    }

    const commitMsg = message || `snapshot ${new Date().toISOString()}`;
    this.git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
    const hash = this.git('rev-parse --short HEAD');

    this.turnSnapshots.add(turnKey);

    log.info('ShadowCheckpoint: snapshot created', { hash, message: commitMsg });
    return hash;
  }

  restore(commitHash: string): void {
    this.ensureRepo();

    if (!COMMIT_HASH_RE.test(commitHash)) {
      throw new Error(`Invalid commit hash: ${commitHash}`);
    }

    // Verify the commit exists
    const verified = this.gitSafe(`cat-file -t ${commitHash}`);
    if (verified !== 'commit') {
      throw new Error(`Commit not found: ${commitHash}`);
    }

    // Auto-snapshot before rollback (undo-the-undo)
    this.preRestoreSnapshot();

    this.git(`checkout ${commitHash} -- .`);
    log.info('ShadowCheckpoint: restored', { commitHash });
  }

  list(limit?: number): string {
    this.ensureRepo();
    const n = limit ?? 20;
    return this.git(`log --oneline -${n}`);
  }

  diff(commitHash?: string): string {
    this.ensureRepo();

    if (commitHash) {
      if (!COMMIT_HASH_RE.test(commitHash)) {
        throw new Error(`Invalid commit hash: ${commitHash}`);
      }
      return this.git(`diff ${commitHash}`);
    }

    return this.git('diff HEAD');
  }

  resetTurn(): void {
    this.turnSnapshots.clear();
  }

  private preRestoreSnapshot(): void {
    try {
      this.git('add -A');
      const status = this.gitSafe('status --porcelain');
      if (status && status.length > 0) {
        this.git('commit -m "pre-restore auto-snapshot"');
        log.info('ShadowCheckpoint: pre-restore snapshot created');
      }
    } catch (err) {
      log.warn('ShadowCheckpoint: pre-restore snapshot failed', { error: String(err) });
    }
  }

  private countFiles(dir: string, maxDepth = 5): number {
    if (maxDepth <= 0) return 0;
    let count = 0;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__' || entry.name === 'dist') {
          continue;
        }
        if (entry.isFile()) {
          count++;
        } else if (entry.isDirectory()) {
          count += this.countFiles(join(dir, entry.name), maxDepth - 1);
        }
        if (count > MAX_FILE_COUNT) return count;
      }
    } catch {
      // Permission denied or similar
    }
    return count;
  }

  validatePath(targetPath: string): void {
    const resolved = resolve(targetPath);
    const rel = relative(this.workDir, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path traversal detected: ${targetPath} is outside ${this.workDir}`);
    }
  }
}

// Global checkpoint instances keyed by workDir
const instances = new Map<string, ShadowCheckpoint>();

function getCheckpoint(workDir: string): ShadowCheckpoint {
  const resolved = resolve(workDir);
  let cp = instances.get(resolved);
  if (!cp) {
    cp = new ShadowCheckpoint(resolved);
    instances.set(resolved, cp);
  }
  return cp;
}

export const checkpointTool: ToolDefinition = buildTool({
  name: 'checkpoint',
  description: 'Shadow git checkpoint: snapshot/restore/list/diff working directory state. Actions: snapshot (save current state), restore (rollback to a commit), list (show history), diff (show changes).',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['snapshot', 'restore', 'list', 'diff'],
        description: 'The checkpoint action to perform'
      },
      work_dir: {
        type: 'string',
        description: 'Working directory to checkpoint (required)'
      },
      message: {
        type: 'string',
        description: 'Snapshot message (for snapshot action)'
      },
      commit_hash: {
        type: 'string',
        description: 'Commit hash (for restore/diff actions)'
      },
      limit: {
        type: 'number',
        description: 'Max entries to show (for list action, default 20)'
      }
    },
    required: ['action', 'work_dir']
  },
  readonly: false,
  category: 'system',

  async execute(input) {
    const action = input.action as string;
    const workDir = input.work_dir as string;

    if (!workDir) {
      return { content: 'work_dir is required', isError: true };
    }

    const cp = getCheckpoint(workDir);

    switch (action) {
      case 'snapshot': {
        const message = input.message as string | undefined;
        const hash = cp.snapshot(message);
        return { content: `Snapshot created: ${hash}`, isError: false };
      }

      case 'restore': {
        const commitHash = input.commit_hash as string;
        if (!commitHash) {
          return { content: 'commit_hash is required for restore', isError: true };
        }
        cp.restore(commitHash);
        return { content: `Restored to ${commitHash}`, isError: false };
      }

      case 'list': {
        const limit = input.limit as number | undefined;
        const history = cp.list(limit);
        return { content: history || '(no checkpoints yet)', isError: false };
      }

      case 'diff': {
        const commitHash = input.commit_hash as string | undefined;
        const diffOutput = cp.diff(commitHash);
        return { content: diffOutput || '(no differences)', isError: false };
      }

      default:
        return { content: `Unknown action: ${action}. Use: snapshot, restore, list, diff`, isError: true };
    }
  }
});

// Helper: auto-snapshot before first file-mutating tool call each turn
export function autoSnapshotIfNeeded(workDir: string): void {
  const cp = getCheckpoint(workDir);
  try {
    cp.snapshot('auto: pre-mutation');
  } catch (err) {
    log.warn('autoSnapshot failed', { workDir, error: String(err) });
  }
}

export function resetCheckpointTurn(workDir: string): void {
  const resolved = resolve(workDir);
  const cp = instances.get(resolved);
  if (cp) cp.resetTurn();
}
