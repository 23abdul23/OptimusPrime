import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GRAPH_DROP_QUERY, NEO4J_CONFIG, NEO4J_DRIVER } from '@/neo4j/neo4j.constants';
import type { Neo4jConfig } from '@/interfaces';
import { Driver, Session, SessionMode } from 'neo4j-driver';
import { RedisService } from '@/redis/redis.service';
import { regexp } from '@/neo4j/neo4j.util';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class Neo4jService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(Neo4jService.name);
  private readonly KEY_EXPIRY: number;
  private gdsAvailabilityWarningShown = false;

  constructor(
    @Inject(NEO4J_CONFIG) private readonly config: Neo4jConfig,
    @Inject(NEO4J_DRIVER) private readonly driver: Driver,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.KEY_EXPIRY = this.configService.get<number>('REDIS_KEY_EXPIRY') ?? 120;
  }

  async onModuleInit() {
    try {
      await this.driver.getServerInfo();
      this.logger.log('Connected to Neo4j');
      this.logger.log(`Database: ${this.config.database}`);
      await this.redisService.onKeyExpiration(async (key: string) => {
        try {
          key = key.replace(regexp`^${this.redisService.keyPrefix}`, '');
          if (key.startsWith('user:')) return;
          await this.dropProjectedGraph(key);
        } catch (error) {
          this.logger.warn(`Skipping projected graph cleanup for "${key}"`);
          this.logger.error(error);
        }
      });
    } catch (error) {
      this.logger.error('Database not connected');
      this.logger.error(error);
    }
  }

  async onModuleDestroy() {
    await this.driver.close();
  }

  async graphExists(graphName: string): Promise<boolean> {
    const session = this.getSession();
    try {
      const result = await session.run<{ exists: boolean }>(
        'CALL gds.graph.exists($graphName) YIELD exists RETURN exists',
        { graphName },
      );
      return result.records[0]?.get('exists') ?? false;
    } catch (error) {
      if (this.isMissingGdsProcedure(error)) {
        this.logMissingGdsOnce();
        return false;
      }

      throw error;
    } finally {
      await this.releaseSession(session);
    }
  }

  async bindGraph(graphName: string, userID: string) {
    const result = await this.redisService.redisClient.multi().get(userID).ttl(userID).exec();
    if (!result) return;
    const [[, val], [, ttl]] = result;
    if (val) {
      if (val === graphName) {
        if ((await this.redisService.redisClient.exists(graphName)) === 1) return;
      } else {
        const num = await this.redisService.redisClient.decr(val as string);
        if (num === 0) {
          await this.redisService.redisClient.del(val as string);
          await this.dropProjectedGraph(val as string);
        }
      }
    }
    await this.redisService.redisClient
      .multi()
      .incr(graphName)
      .expire(graphName, this.KEY_EXPIRY)
      .set(userID, graphName, 'EX', Math.max(ttl as number, 120))
      .exec();
  }

  getSession(mode: SessionMode = 'READ'): Session {
    return this.driver.session({
      database: this.config.database,
      defaultAccessMode: mode,
    });
  }

  async releaseSession(session: Session) {
    await session.close();
  }

  private async dropProjectedGraph(graphName: string) {
    const exists = await this.graphExists(graphName);
    if (!exists) {
      return;
    }

    const session = this.getSession('WRITE');
    try {
      await session.run(GRAPH_DROP_QUERY, { graphName });
    } catch (error) {
      if (this.isMissingGdsProcedure(error)) {
        this.logMissingGdsOnce();
        return;
      }

      throw error;
    } finally {
      await this.releaseSession(session);
    }
  }

  private isMissingGdsProcedure(error: unknown) {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const code = 'code' in error ? String(error.code) : '';
    const message = 'message' in error ? String(error.message) : '';

    return (
      code === 'Neo.ClientError.Procedure.ProcedureNotFound' &&
      (message.includes('gds.graph.exists') || message.includes('gds.graph.drop'))
    );
  }

  private logMissingGdsOnce() {
    if (this.gdsAvailabilityWarningShown) {
      return;
    }

    this.gdsAvailabilityWarningShown = true;
    this.logger.warn('Neo4j GDS procedures are unavailable. Projected-graph cache cleanup is disabled.');
  }
}
