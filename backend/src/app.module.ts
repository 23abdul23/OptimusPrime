import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { Neo4jModule } from './neo4j/neo4j.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Neo4jScheme } from '@/interfaces';
import { GraphqlModule } from './graphql/graphql.module';
import { LlmModule } from './llm/llm.module';
import { AlgorithmModule } from './algorithm/algorithm.module';
import { RedisModule } from './redis/redis.module';
import { RedisService } from '@/redis/redis.service';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';
import { OptimusKgModule } from './optimuskg/optimuskg.module';
import { GraphAgentModule } from './graph-agent/graph-agent.module';

function parseNeo4jUri(uri?: string): { scheme: Neo4jScheme; host: string; port: number } | null {
  if (!uri) {
    return null;
  }

  try {
    const parsed = new URL(uri);
    return {
      scheme: parsed.protocol.replace(':', '') as Neo4jScheme,
      host: parsed.hostname,
      port: Number(parsed.port || 7687),
    };
  } catch {
    return null;
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../.env'],
      cache: true,
    }),
    Neo4jModule.forRootAsync({
      useFactory: (configService: ConfigService) => {
        const uriConfig = parseNeo4jUri(
          configService.get<string>('NEO4J_URI') ?? configService.get<string>('OPTIMUS_NEO4J_URI'),
        );

        return {
          scheme: uriConfig?.scheme ?? configService.get<Neo4jScheme>('NEO4J_SCHEME', 'bolt'),
          host: uriConfig?.host ?? configService.get<string>('NEO4J_HOST', 'localhost'),
          port: uriConfig?.port ?? configService.get<number>('NEO4J_PORT', 7687),
          username:
            configService.get<string>('NEO4J_USERNAME') ??
            configService.get<string>('OPTIMUS_NEO4J_USERNAME', 'neo4j'),
          password:
            configService.get<string>('NEO4J_PASSWORD') ??
            configService.get<string>('OPTIMUS_NEO4J_PASSWORD', ''),
          database:
            configService.get<string>('NEO4J_DATABASE') ??
            configService.get<string>('OPTIMUS_NEO4J_DATABASE', 'neo4j'),
        };
      },
      inject: [ConfigService],
    }),
    GraphqlModule,
    LlmModule,
    AlgorithmModule,
    {
      module: RedisModule,
      global: true,
      exports: [RedisService],
    },
    OptimusKgModule,
    GraphAgentModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useClass: ZodValidationPipe,
    },
  ],
  controllers: [AppController],
})
export class AppModule {}
