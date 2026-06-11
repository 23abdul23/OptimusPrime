import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { OptimusKgModule } from '@/optimuskg/optimuskg.module';
import { ThrottlerBehindProxyGuard } from '@/llm/llm-throttle.guard';
import { ClarificationAgentService } from './clarification-agent.service';
import { ConversationGraphStateService } from './conversation-graph-state.service';
import { EvidenceAgentService } from './evidence-agent.service';
import { EntityExtractionService } from './entity-extraction.service';
import { EntityResolutionAgentService } from './entity-resolution-agent.service';
import { CypherAgentService } from './cypher-agent.service';
import { GraphAnalysisService } from './graph-analysis.service';
import { GraphContextAgentService } from './graph-context-agent.service';
import { GraphAgentLlmService } from './graph-agent-llm.service';
import { GraphAgentController } from './graph-agent.controller';
import { GraphAgentService } from './graph-agent.service';
import { GraphInterpretationService } from './graph-interpretation.service';
import { GraphRetrieverService } from './graph-retriever.service';
import { IntentAgentService } from './intent-agent.service';
import { QueryRouterService } from './query-router.service';
import { QueryDecompositionAgentService } from './query-decomposition-agent.service';
import { ReasoningAgentService } from './reasoning-agent.service';
import { ReplanningAgentService } from './replanning-agent.service';
import { RetrievalOperationsService } from './retrieval-operations.service';
import { RetrievalPlanningAgentService } from './retrieval-planning-agent.service';
import { ExploreAnswerNetworkService } from './explore-answer-network.service';

@Module({
  imports: [
    OptimusKgModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            name: 'short',
            ttl: 10000,
            limit: 20,
          },
          {
            name: 'long',
            ttl: 60000,
            limit: 40,
          },
        ],
        storage: new ThrottlerStorageRedisService(
          new Redis({
            host: configService.get('REDIS_HOST', 'localhost'),
            port: configService.get('REDIS_PORT', 6379),
            password: configService.get('REDIS_PASSWORD'),
            keyPrefix: 'throttler:graph-agent:',
          }),
        ),
      }),
    }),
  ],
  controllers: [GraphAgentController],
  providers: [
    ThrottlerBehindProxyGuard,
    ClarificationAgentService,
    ConversationGraphStateService,
    GraphAgentLlmService,
    GraphContextAgentService,
    EntityExtractionService,
    IntentAgentService,
    EntityResolutionAgentService,
    QueryRouterService,
    QueryDecompositionAgentService,
    RetrievalPlanningAgentService,
    RetrievalOperationsService,
    CypherAgentService,
    GraphAnalysisService,
    GraphInterpretationService,
    GraphRetrieverService,
    EvidenceAgentService,
    ReplanningAgentService,
    ReasoningAgentService,
    GraphAgentService,
    ExploreAnswerNetworkService,
  ],
})
export class GraphAgentModule {}
