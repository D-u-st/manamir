// Permission system (P-24 simplified) — role-based access control
// Maps Discord user IDs to permission levels, checks before actions

import { log } from '../utils/logger';

export type PermissionLevel = 'admin' | 'user' | 'readonly';

export interface PermissionConfig {
  /** Map of Discord user ID -> permission level */
  userPermissions: Record<string, PermissionLevel>;
  /** Default permission for allowed (but unlisted) users */
  defaultLevel: PermissionLevel;
}

type Action =
  | 'chat'
  | 'use_tools'
  | 'manage_tasks'
  | 'auto_start'
  | 'auto_stop'
  | 'cron_manage'
  | 'view_status'
  | 'manage_permissions';

const ACTION_REQUIREMENTS: Record<Action, PermissionLevel[]> = {
  chat: ['admin', 'user'],
  use_tools: ['admin', 'user'],
  manage_tasks: ['admin', 'user'],
  auto_start: ['admin'],
  auto_stop: ['admin'],
  cron_manage: ['admin'],
  view_status: ['admin', 'user', 'readonly'],
  manage_permissions: ['admin']
};

export class PermissionManager {
  private userLevels = new Map<string, PermissionLevel>();
  private defaultLevel: PermissionLevel;

  constructor(config: PermissionConfig) {
    this.defaultLevel = config.defaultLevel;
    for (const [userId, level] of Object.entries(config.userPermissions)) {
      this.userLevels.set(userId, level);
    }
    log.info('PermissionManager: initialized', {
      users: this.userLevels.size,
      defaultLevel: this.defaultLevel
    });
  }

  getLevel(userId: string): PermissionLevel {
    return this.userLevels.get(userId) ?? this.defaultLevel;
  }

  setLevel(userId: string, level: PermissionLevel): void {
    this.userLevels.set(userId, level);
    log.info('PermissionManager: level set', { userId, level });
  }

  check(userId: string, action: Action): boolean {
    const level = this.getLevel(userId);
    const allowed = ACTION_REQUIREMENTS[action];
    return allowed.includes(level);
  }

  /** Check and return a denial message if not permitted, or null if allowed */
  guard(userId: string, action: Action): string | null {
    if (this.check(userId, action)) return null;
    const level = this.getLevel(userId);
    return `Permission denied. Your level is \`${level}\`, but \`${action}\` requires one of: ${ACTION_REQUIREMENTS[action].join(', ')}.`;
  }

  listUsers(): Array<{ userId: string; level: PermissionLevel }> {
    return [...this.userLevels.entries()].map(([userId, level]) => ({ userId, level }));
  }
}
