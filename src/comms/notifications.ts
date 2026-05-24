// 4-level notification system (P-86)
// Dedup + rate limiting + per-channel preferences

export type NotificationLevel = 'debug' | 'info' | 'warning' | 'critical';

const LEVEL_EMOJI: Record<NotificationLevel, string> = {
  debug: '\u{1F41B}',    // bug
  info: '\u{2139}\uFE0F', // info
  warning: '\u{26A0}\uFE0F', // warning
  critical: '\u{1F6A8}'  // siren
};

const LEVEL_PRIORITY: Record<NotificationLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  critical: 3
};

export interface ChannelPreferences {
  minLevel: NotificationLevel;
}

interface RateState {
  timestamps: number[];   // recent send timestamps
  recentMessages: Map<string, number>; // message hash -> last sent time
}

export type NotificationSink = (channelId: string, formatted: string) => void | Promise<void>;

const DEDUP_WINDOW_MS = 60_000;
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60_000;

export class NotificationManager {
  private channelPrefs: Map<string, ChannelPreferences> = new Map();
  private rateState: Map<string, RateState> = new Map();
  private sink: NotificationSink | null = null;

  /** Set the output sink that actually delivers notifications */
  setSink(sink: NotificationSink): void {
    this.sink = sink;
  }

  /** Configure notification preferences for a channel */
  setChannelPreferences(channelId: string, prefs: ChannelPreferences): void {
    this.channelPrefs.set(channelId, prefs);
  }

  /** Remove channel preferences (stops receiving notifications) */
  removeChannel(channelId: string): void {
    this.channelPrefs.delete(channelId);
    this.rateState.delete(channelId);
  }

  /** Get all subscribed channel IDs */
  getSubscribedChannels(): string[] {
    return [...this.channelPrefs.keys()];
  }

  /** Send a notification to all subscribed channels that accept this level */
  async notify(level: NotificationLevel, message: string): Promise<void> {
    if (!this.sink) return;

    const formatted = this.format(level, message);

    for (const [channelId, prefs] of this.channelPrefs) {
      if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[prefs.minLevel]) continue;
      if (!this.checkRateAndDedup(channelId, message)) continue;

      await this.sink(channelId, formatted);
    }
  }

  /** Send a notification to a specific channel */
  async notifyChannel(channelId: string, level: NotificationLevel, message: string): Promise<void> {
    if (!this.sink) return;

    const prefs = this.channelPrefs.get(channelId);
    if (prefs && LEVEL_PRIORITY[level] < LEVEL_PRIORITY[prefs.minLevel]) return;
    if (!this.checkRateAndDedup(channelId, message)) return;

    const formatted = this.format(level, message);
    await this.sink(channelId, formatted);
  }

  private format(level: NotificationLevel, message: string): string {
    const emoji = LEVEL_EMOJI[level];
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    return `${emoji} [${ts}] ${message}`;
  }

  private checkRateAndDedup(channelId: string, message: string): boolean {
    let state = this.rateState.get(channelId);
    if (!state) {
      state = { timestamps: [], recentMessages: new Map() };
      this.rateState.set(channelId, state);
    }

    const now = Date.now();

    // Dedup: same message within 60s
    const lastSent = state.recentMessages.get(message);
    if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
      return false;
    }

    // Rate limit: max 5 per minute
    state.timestamps = state.timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (state.timestamps.length >= RATE_LIMIT) {
      return false;
    }

    // Passed checks — record this send
    state.timestamps.push(now);
    state.recentMessages.set(message, now);

    // Clean old dedup entries
    for (const [msg, ts] of state.recentMessages) {
      if (now - ts >= DEDUP_WINDOW_MS) {
        state.recentMessages.delete(msg);
      }
    }

    return true;
  }
}
