// Session key builder — 
// Produces deterministic session keys so the same conversation routes to the
// same in-memory session across restarts.

import type { MessageEvent } from './types';

export interface SessionRoutingConfig {
  groupSessionsPerUser: boolean;
  threadSessionsPerUser: boolean;
}

export const DEFAULT_ROUTING: SessionRoutingConfig = {
  groupSessionsPerUser: false,
  threadSessionsPerUser: false,
};

export function buildSessionKey(
  event: MessageEvent,
  config: SessionRoutingConfig = DEFAULT_ROUTING
): string {
  const platform = event.platform ?? 'unknown';
  const { source, channelId, userId } = event;

  if (source === 'dm') {
    return channelId
      ? `agent:main:${platform}:dm:${channelId}`
      : `agent:main:${platform}:dm`;
  }

  const parts = ['agent:main', platform, source];
  if (channelId) parts.push(channelId);

  let isolateUser: boolean;
  if (source === 'thread') {
    isolateUser = config.threadSessionsPerUser;
  } else {
    isolateUser = config.groupSessionsPerUser;
  }

  if (isolateUser && userId) {
    parts.push(userId);
  }

  return parts.join(':');
}
