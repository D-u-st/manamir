// RFC-004: Memory Freshness
// 
//
// 动机（原注释）：
//   "Models are poor at date arithmetic — a raw ISO timestamp doesn't
//    trigger staleness reasoning the way '47 days ago' does."
//
//   "Motivated by user reports of stale code-state memories (file:line
//    citations to code that has since changed) being asserted as fact —
//    the citation makes the stale claim sound more authoritative, not less."
//
// manamir 适配：
//   - 按 type 差异化阈值（原版是统一 >1 天警告，我们分 project/feedback/reference/user）
//   - 警告文本中英混合（原版纯英文），DeepSeek 友好
//   - 加 grep 具体例子，引用 Round 1 8 ghost P0 教训

import type { Memory, MemoryType } from './types';

/**
 * 按 type 分层的阈值（天）。超过阈值才 emit 警告。
 * 逻辑: project 状态变快 → 3 天；feedback/user 偏好稳定 → 30 天。
 */
const FRESHNESS_THRESHOLD_DAYS: Record<MemoryType, number> = {
  project: 3,           // 状态类，变化最快
  feedback: 30,         // 用户偏好类，变化慢
  reference: 60,        // 外部系统指针，相对稳定
  user: 30,             // 用户角色/知识，变化慢
  'ocr-history': 7,     // OCR 提取的图片文本，中等时效
};

/** 默认阈值（未知 type 或兜底）。 */
const DEFAULT_THRESHOLD_DAYS = 7;

/**
 * O(1) 日期差，clamp 0。Negative inputs（future mtime, clock skew）clamp 到 0。
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

/**
 * Human-readable age 字符串。原话：
 *   "A raw ISO timestamp doesn't trigger staleness reasoning the way
 *    '47 days ago' does."
 */
export function memoryAgeText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

/**
 * 返回 staleness 警告文本，或空串（若 fresh）。
 *
 * 新（RFC-004 manamir 版本）:
 *   - 阈值按 memory type 分层（原版固定 >1 天）
 *   - 中英混合文本（括号内中文，DeepSeek 适配）
 *   - 加 grep 例子 + Round 1 教训引用
 */
export function memoryFreshnessText(mtimeMs: number, type?: MemoryType): string {
  const d = memoryAgeDays(mtimeMs);
  const threshold = type && type in FRESHNESS_THRESHOLD_DAYS
    ? FRESHNESS_THRESHOLD_DAYS[type]
    : DEFAULT_THRESHOLD_DAYS;

  if (d <= threshold) return '';

  return (
    `⚠️ This memory is ${d} days old (此记忆已 ${d} 天). ` +
    `Memory is a point-in-time snapshot — if it says "bug X in file:line" ` +
    `or references specific functions, grep the code to verify before acting. ` +
    `Lesson from Round 1: 8 "unfixed" P0 claims were all already fixed — always verify.`
  );
}

/**
 * 包 <system-reminder> 标签。标准格式。
 */
export function memoryFreshnessNote(mtimeMs: number, type?: MemoryType): string {
  const text = memoryFreshnessText(mtimeMs, type);
  if (!text) return '';
  return `<system-reminder>${text}</system-reminder>\n`;
}

/**
 * manamir 专用便利函数：接受 Memory 对象（比直接传 mtimeMs 方便）。
 */
export function freshnessNoteForMemory(memory: Memory): string {
  return memoryFreshnessNote(memory.updatedAt, memory.type);
}
