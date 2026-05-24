// Swarm Mailbox (P-35) — simple message passing between agents.
// Agents can send point-to-point or broadcast messages during concurrent execution.

import { log } from '../utils/logger';
import type { MailboxMessage } from './types';

let messageCounter = 0;

export class Mailbox {
  private messages: MailboxMessage[] = [];
  private knownAgents = new Set<string>();

  /** Register an agent so broadcasts reach it */
  register(agentId: string): void {
    this.knownAgents.add(agentId);
  }

  /** Unregister an agent */
  unregister(agentId: string): void {
    this.knownAgents.delete(agentId);
  }

  /** Send a message from one agent to another */
  send(fromId: string, toId: string, content: string): void {
    const msg: MailboxMessage = {
      id: `msg_${++messageCounter}_${Date.now()}`,
      fromId,
      toId,
      content,
      timestamp: Date.now(),
      read: false
    };
    this.messages.push(msg);
    log.debug('Mailbox: message sent', { from: fromId, to: toId, id: msg.id });
  }

  /** Broadcast a message to all registered agents (except sender) */
  broadcast(fromId: string, content: string): void {
    for (const agentId of this.knownAgents) {
      if (agentId !== fromId) {
        this.send(fromId, agentId, content);
      }
    }
  }

  /** Receive all unread messages for an agent, marking them as read */
  receive(agentId: string): MailboxMessage[] {
    const unread = this.messages.filter(
      m => (m.toId === agentId || m.toId === '*') && !m.read && m.fromId !== agentId
    );
    for (const m of unread) {
      m.read = true;
    }
    return unread;
  }

  /** Peek at unread messages without marking them read */
  peek(agentId: string): MailboxMessage[] {
    return this.messages.filter(
      m => (m.toId === agentId || m.toId === '*') && !m.read && m.fromId !== agentId
    );
  }

  /** Get count of unread messages for an agent */
  unreadCount(agentId: string): number {
    return this.messages.filter(
      m => (m.toId === agentId || m.toId === '*') && !m.read && m.fromId !== agentId
    ).length;
  }

  /** Clear all messages (e.g. after a coordination run) */
  clear(): void {
    this.messages = [];
    messageCounter = 0;
  }

  /** Prune read messages older than maxAgeMs */
  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.messages.length;
    this.messages = this.messages.filter(
      m => !m.read || m.timestamp > cutoff
    );
    return before - this.messages.length;
  }

  get totalMessages(): number {
    return this.messages.length;
  }

  get registeredAgents(): string[] {
    return [...this.knownAgents];
  }
}
