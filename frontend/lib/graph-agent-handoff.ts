'use client';

import type { GraphAgentUIMessage } from './graph-agent-types';

const GRAPH_AGENT_HANDOFF_STORAGE_KEY = 'graph-agent:explore-to-kg-handoff';
const GRAPH_AGENT_HANDOFF_MAX_AGE_MS = 15 * 60 * 1000;

export interface GraphAgentHandoffSnapshot {
  createdAt: string;
  sourceRoute: '/explore';
  sessionId: string;
  model: string;
  messages: GraphAgentUIMessage[];
}

export function saveGraphAgentHandoffSnapshot(snapshot: GraphAgentHandoffSnapshot) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(GRAPH_AGENT_HANDOFF_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.error('Failed to persist graph-agent handoff snapshot:', error);
  }
}

export function loadGraphAgentHandoffSnapshot() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(GRAPH_AGENT_HANDOFF_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as GraphAgentHandoffSnapshot;
    const createdAt = Date.parse(parsed.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > GRAPH_AGENT_HANDOFF_MAX_AGE_MS) {
      clearGraphAgentHandoffSnapshot();
      return null;
    }

    if (!parsed.sessionId || !Array.isArray(parsed.messages)) {
      clearGraphAgentHandoffSnapshot();
      return null;
    }

    return parsed;
  } catch (error) {
    console.error('Failed to read graph-agent handoff snapshot:', error);
    clearGraphAgentHandoffSnapshot();
    return null;
  }
}

export function clearGraphAgentHandoffSnapshot() {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    localStorage.removeItem(GRAPH_AGENT_HANDOFF_STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear graph-agent handoff snapshot:', error);
  }
}
