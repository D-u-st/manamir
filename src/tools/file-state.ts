// RFC-005 Layer 2: File State tracking for staleness check.
//
// ToolUseContext.readFileState (Map<path, {content, timestamp, offset?, limit?}>)
//
// 用途: edit/write 前验证 AI 看过的文件内容跟当前磁盘一致。
//   - AI 没 read 过 → 拒绝（强制先 read，防瞎猜路径）
//   - read 后被外部改了 → 拒绝（防盖掉 user/linter 改动）
//   - mtime 动了但 content 相同 → OK（Windows cloud sync / antivirus 误报防护）

import { resolve } from 'path';

export interface FileState {
  /** Full file content as read by the read tool. */
  content: string;
  /** mtime in ms when read. */
  mtimeMs: number;
  /** Optional: partial-view markers (standard). undefined = full read. */
  offset?: number;
  limit?: number;
}

// 模式跟 selfReview.ts memoryStoreRef 同款（module-level singleton state）。
// 每 Session 共享一个 Map（合理：一个 manamir 进程 = 一个 user session）。
const fileStateMap: Map<string, FileState> = new Map();

/** Normalize path 到 absolute + 标准形式，防 cwd / `..` / 大小写漂移。 */
function normalizePath(p: string): string {
  return resolve(p);
}

export function setFileState(path: string, state: FileState): void {
  fileStateMap.set(normalizePath(path), state);
}

export function getFileState(path: string): FileState | undefined {
  return fileStateMap.get(normalizePath(path));
}

export function clearFileState(): void {
  fileStateMap.clear();
}

/**
 * Staleness check verdict — null = OK, string = error message.
 *
 * 检查规则（ 450-469）:
 *   1. 没 read 过 → "File has not been read yet. Read it first..."
 *   2. mtime 动了：
 *      - full read 且 content 相同 → OK (Windows mtime 误报防护)
 *      - 否则 → "File has been modified since read..."
 *   3. mtime 没动 → OK
 */
export function checkFileStaleness(
  path: string,
  currentContent: string,
  currentMtimeMs: number
): string | null {
  const state = getFileState(path);

  if (!state) {
    return (
      'File has not been read yet (尚未读取此文件). ' +
      'Read it with the `read` tool first before attempting to write/edit.'
    );
  }

  if (currentMtimeMs > state.mtimeMs) {
    // Windows fallback: mtime 动了但 content 相同 (cloud sync / antivirus / git 等会改 mtime)
    const isFullRead = state.offset === undefined && state.limit === undefined;
    if (isFullRead && currentContent === state.content) {
      return null; // safe, content unchanged
    }
    return (
      'File has been modified since last read (文件在上次读取后已被修改). ' +
      'Either the user or a linter changed it. ' +
      'Read it again with the `read` tool before attempting to write/edit.'
    );
  }

  return null; // fresh
}
