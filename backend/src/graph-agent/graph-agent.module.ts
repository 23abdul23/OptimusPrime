import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import Redis from 'ioredis';
import { OptimusKgModule } from '@/optimuskg/optimuskg.module';
import { ThrottlerBehindProxyGuard } from '@/llm/llm-throttle.guard';
import { ConversationGraphStateService } from './conversation-graph-state.service';
import { EntityExtractionService } from './entity-extraction.service';
import { EntityResolutionService } from './entity-resolution.service';
import { EvidenceSelectionService } from './evidence-selection.service';
import { GraphContextAgentService } from './graph-context-agent.service';
import { GraphAgentController } from './graph-agent.controller';
import { GraphAgentService } from './graph-agent.service';
import { GraphRetrieverService } from './graph-retriever.service';
import { QueryRouterService } from './query-router.service';
import { ResponseSynthesisService } from './response-synthesis.service';
import { RetrievalPlannerService } from './retrieval-planner.service';

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
    ConversationGraphStateService,
    GraphContextAgentService,
    EntityExtractionService,
    EntityResolutionService,
    QueryRouterService,
    RetrievalPlannerService,
    GraphRetrieverService,
    EvidenceSelectionService,
    ResponseSynthesisService,
    GraphAgentService,
  ],
})
export class GraphAgentModule {}
