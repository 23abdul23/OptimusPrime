import { Module } from '@nestjs/common';
import { GraphqlResolver } from './graphql.resolver';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'node:path';
import { GraphqlService } from './graphql.service';
import GraphQLJSON from 'graphql-type-json';
import { ApolloDriver } from '@/utils/apollo';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    GraphQLModule.forRootAsync({
      driver: ApolloDriver,
      useFactory: (configService: ConfigService) => ({
        autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
        sortSchema: true,
        resolvers: { JSON: GraphQLJSON },
        path: '/graphql',
        playground: configService.get<string>('NODE_ENV', 'development') !== 'production',
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [GraphqlResolver, GraphqlService],
})
export class GraphqlModule {}
