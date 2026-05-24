// Atomic file write (P-68): tmpfile + rename + optional backup
// Prevents partial writes from corrupting data

import { writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

export function atomicWriteSync(filePath: string, content: string, backup = false): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Backup existing file if requested
  if (backup && existsSync(filePath)) {
    const backupPath = filePath + '.bak';
    copyFileSync(filePath, backupPath);
  }

  // Write to temp file in same directory (same filesystem = atomic rename)
  const tmpPath = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

export async function atomicWrite(filePath: string, content: string, backup = false): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (backup && existsSync(filePath)) {
    const backupPath = filePath + '.bak';
    copyFileSync(filePath, backupPath);
  }

  const tmpPath = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  const { writeFile } = await import('fs/promises');
  await writeFile(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}
