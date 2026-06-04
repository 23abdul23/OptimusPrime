import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import type { ConversationGraphState } from './graph-agent.types';

const STATE_TTL_SECONDS = 60 * 60 * 12;
const MAX_EVIDENCE_ITEMS = 15;
const MAX_TRACKED_NODE_IDS = 200;
const MAX_PRIOR_QUERIES = 12;

@Injectable()
export class ConversationGraphStateService {
  constructor(private readonly redisService: RedisService) {}

  private cacheKey(sessionId: string) {
    return `graph-agent:state:${sessionId}`;
  }

  private defaultState(sessionId: string): ConversationGraphState {
    return {
      sessionId,
      activeEntities: [],
      resolvedNodeIds: [],
      frontierNodeIds: [],
      retrievedNodeIds: [],
      evidenceCache: [],
      priorQueries: [],
      lastPlan: [],
      selectedNodeIds: [],
      selectedEdgeIds: [],
      visibleNodeIds: [],
      visibleEdgeIds: [],
      updatedAt: new Date().toISOString(),
    };
  }

  async getConversationGraphState(sessionId: string) {
    try {
      const cached = await this.redisService.redisClient.get(this.cacheKey(sessionId));
      if (!cached) {
        return this.defaultState(sessionId);
      }

      return {
        ...this.defaultState(sessionId),
        ...(JSON.parse(cached) as ConversationGraphState),
      };
    } catch {
      return this.defaultState(sessionId);
    }
  }

  async saveConversationGraphState(state: ConversationGraphState) {
    const pruned = this.pruneConversationGraphState(state);
    await this.redisService.redisClient.set(
      this.cacheKey(pruned.sessionId),
      JSON.stringify(pruned),
      'EX',
      STATE_TTL_SECONDS,
    );
    return pruned;
  }

  pruneConversationGraphState(state: ConversationGraphState): ConversationGraphState {
    return {
      ...state,
      activeEntities: state.activeEntities.slice(0, 8),
      resolvedNodeIds: [...new Set(state.resolvedNodeIds)].slice(0, MAX_TRACKED_NODE_IDS),
      frontierNodeIds: [...new Set(state.frontierNodeIds)].slice(0, MAX_TRACKED_NODE_IDS),
      retrievedNodeIds: [...new Set(state.retrievedNodeIds)].slice(0, MAX_TRACKED_NODE_IDS),
      evidenceCache: state.evidenceCache.slice(0, MAX_EVIDENCE_ITEMS),
      priorQueries: state.priorQueries.slice(0, MAX_PRIOR_QUERIES),
      selectedNodeIds: [...new Set(state.selectedNodeIds)].slice(0, 32),
      selectedEdgeIds: [...new Set(state.selectedEdgeIds)].slice(0, 64),
      visibleNodeIds: [...new Set(state.visibleNodeIds)].slice(0, MAX_TRACKED_NODE_IDS),
      visibleEdgeIds: [...new Set(state.visibleEdgeIds)].slice(0, MAX_TRACKED_NODE_IDS * 2),
      updatedAt: new Date().toISOString(),
    };
  }
}
