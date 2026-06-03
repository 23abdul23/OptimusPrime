import { GqlModuleOptions, SubscriptionConfig } from '@nestjs/graphql';
import type { ApolloServerOptionsWithTypeDefs } from '@apollo/server';
import { GraphiQLOptions } from './graphiql-options';

/**
 *  @publicApi
 */
export interface ServerRegistration {
  /**
   * Path to mount GraphQL API
   */
  path?: string;
}

/**
 * @publicApi
 */
export interface ApolloDriverConfig
  extends Omit<ApolloServerOptionsWithTypeDefs<any>, 'typeDefs' | 'schema' | 'resolvers' | 'gateway'>,
    ServerRegistration,
    GqlModuleOptions {
  /**
   * If enabled, "subscriptions-transport-ws" will be automatically registered.
   */
  installSubscriptionHandlers?: boolean;

  /**
   * Subscriptions configuration.
   */
  subscriptions?: SubscriptionConfig;

  /**
   * Playground options, or a boolean to enable playground with default options.
   */
  playground?: boolean | Record<string, any>;
  /**
   * GraphiQL options, or a boolean to enable GraphiQL with default options.
   */
  graphiql?: boolean | GraphiQLOptions;

  /**
   * If enabled, will register a global interceptor that automatically maps
   * "HttpException" class instances to corresponding Apollo errors.
   * @default true
   */
  autoTransformHttpErrors?: boolean;
}
