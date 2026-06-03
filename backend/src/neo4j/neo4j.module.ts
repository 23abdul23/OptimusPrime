import { DynamicModule, InjectionToken, Module } from '@nestjs/common';
import { Neo4jService } from './neo4j.service';
import { Neo4jConfig } from '@/interfaces';
import { NEO4J_CONFIG, NEO4J_DRIVER } from './neo4j.constants';
import { createDriver } from '@/neo4j/neo4j.util';

@Module({
  providers: [Neo4jService],
})
export class Neo4jModule {
  static forRootAsync(options: {
    useFactory: (...args: any[]) => Promise<Neo4jConfig> | Neo4jConfig;
    inject?: InjectionToken[];
  }): DynamicModule {
    return {
      module: Neo4jModule,
      global: true,
      providers: [
        {
          provide: NEO4J_CONFIG,
          useFactory: options.useFactory,
          inject: options.inject,
        },
        {
          provide: NEO4J_DRIVER,
          inject: [NEO4J_CONFIG],
          useFactory: async (config: Neo4jConfig) => createDriver(config),
        },
        Neo4jService,
      ],
      exports: [Neo4jService],
    };
  }
}
