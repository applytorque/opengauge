/**
 * Session grouping heuristics for proxy watch mode.
 *
 * Groups requests into sessions based on:
 *   - API key / caller identity
 *   - Time window (5 minute inactivity = new session)
 *   - Custom x-opengauge-session header
 *   - x-opengauge-project header
 */

import { getDb } from '../db';
import { SessionQueries, type SessionRecord } from '../db/session-queries';

interface ActiveSession {
  record: SessionRecord;
  lastActivity: number;
  interactionCount: number;
  contextDepthTokens: number;
}

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class ProxySessionManager {
  private sessions = new Map<string, ActiveSession>();
  private queries: SessionQueries;

  constructor() {
    this.queries = new SessionQueries(getDb());
  }

  /**
   * Derive a session key from request headers.
   */
  private deriveSessionKey(headers: Record<string, string | string[] | undefined>): string {
    // Explicit session header takes priority
    const explicit = headers['x-opengauge-session'];
    if (explicit) return `explicit:${explicit}`;

    // API key-based grouping
    const apiKey = headers['authorization'] || headers['x-api-key'] || '';
    const keyStr = typeof apiKey === 'string' ? apiKey : Array.isArray(apiKey) ? apiKey[0] : '';
    // Hash the key to avoid storing secrets
    const keyHash = simpleHash(keyStr);

    const project = headers['x-opengauge-project'];
    if (project) return `key:${keyHash}:proj:${project}`;

    return `key:${keyHash}`;
  }

  /**
   * Get or create a session for the given request.
   */
  getSession(
    headers: Record<string, string | string[] | undefined>,
    provider: string,
    model: string
  ): { session: SessionRecord; interactionCount: number; contextDepthTokens: number } {
    const key = this.deriveSessionKey(headers);
    const now = Date.now();

    const existing = this.sessions.get(key);

    if (existing && (now - existing.lastActivity) < SESSION_TIMEOUT_MS) {
      existing.lastActivity = now;
      return {
        session: existing.record,
        interactionCount: existing.interactionCount,
        contextDepthTokens: existing.contextDepthTokens,
      };
    }

    // Finalize old session if it exists
    if (existing) {
      try {
        this.queries.finalizeSession(existing.record.id);
      } catch { /* ignore */ }
    }

    // Create new session
    const projectDir = headers['x-opengauge-project']
      ? String(headers['x-opengauge-project'])
      : undefined;

    const record = this.queries.createSession('proxy', model, provider, projectDir);

    const active: ActiveSession = {
      record,
      lastActivity: now,
      interactionCount: 0,
      contextDepthTokens: 0,
    };
    this.sessions.set(key, active);

    return {
      session: record,
      interactionCount: 0,
      contextDepthTokens: 0,
    };
  }

  /**
   * Record that an interaction happened in a session.
   */
  recordInteraction(
    headers: Record<string, string | string[] | undefined>,
    tokensIn: number
  ): number {
    const key = this.deriveSessionKey(headers);
    const active = this.sessions.get(key);
    if (active) {
      active.interactionCount++;
      active.contextDepthTokens += tokensIn;
      active.lastActivity = Date.now();
      return active.interactionCount;
    }
    return 1;
  }

  /**
   * Finalize all active sessions (called on shutdown).
   */
  shutdown(): void {
    for (const [, active] of this.sessions) {
      try {
        this.queries.finalizeSession(active.record.id);
      } catch { /* ignore */ }
    }
    this.sessions.clear();
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
