import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger: Logger = new Logger(RedisService.name);
  readonly redisClient: Redis;
  private readonly _redisClient: Redis;
  keyPrefix = 'nestjs:';

  constructor(private readonly configService: ConfigService) {
    this.redisClient = new Redis({
      host: this.configService.get('REDIS_HOST', 'localhost'),
      port: this.configService.get('REDIS_PORT', 6379),
      keyPrefix: this.keyPrefix,
      password: this.configService.get('REDIS_PASSWORD'),
      maxRetriesPerRequest: 3,
    });
    this._redisClient = new Redis({
      host: this.configService.get('REDIS_HOST', 'localhost'),
      port: this.configService.get('REDIS_PORT', 6379),
      password: this.configService.get('REDIS_PASSWORD'),
      maxRetriesPerRequest: 3,
    });
  }

  async onModuleInit() {
    this.logger.log(`Redis connected on port ${this.redisClient.options.port}`);
    await this.redisClient.config('SET', 'notify-keyspace-events', 'Ex');
    await this._redisClient.subscribe('__keyevent@0__:expired');
  }

  async onModuleDestroy() {
    await this.redisClient.quit();
  }

  async onKeyExpiration(callback: (key: string) => void | Promise<void>) {
    this._redisClient.on('message', async (_channel, key) => {
      await callback(key);
    });
  }
}
