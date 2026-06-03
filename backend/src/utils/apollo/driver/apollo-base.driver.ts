import { AbstractGraphQLDriver } from '@nestjs/graphql';
import { ApolloServer, BaseContext } from '@apollo/server';
import { ApolloServerErrorCode, unwrapResolverError } from '@apollo/server/errors';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { expressMiddleware } from '@as-integrations/express5';
import { HttpStatus } from '@nestjs/common';
import { GraphQLError, GraphQLFormattedError } from 'graphql';

import { ApolloDriverConfig, GraphiQLOptions } from '../interfaces';
import { GraphiQLPlaygroundPlugin } from '../graphiql';

const apolloPredefinedExceptions: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: ApolloServerErrorCode.BAD_REQUEST,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ApolloServerErrorCode.BAD_USER_INPUT,
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
};

export abstract class ApolloBaseDriver<
  T extends Record<string, any> = ApolloDriverConfig,
> extends AbstractGraphQLDriver<T> {
  protected apolloServer: ApolloServer<BaseContext>;

  get instance(): ApolloServer<BaseContext> {
    return this.apolloServer;
  }

  public async start(apolloOptions: T) {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const platformName = httpAdapter.getType();

    if (platformName === 'express') {
      await this.registerExpress(apolloOptions);
    } else if (platformName === 'fastify') {
      await this.registerFastify(apolloOptions);
    } else {
      throw new Error(`No support for current HttpAdapter: ${platformName}`);
    }
  }

  public stop() {
    return this.apolloServer?.stop();
  }

  public async mergeDefaultOptions(options: T): Promise<T> {
    let defaults: ApolloDriverConfig = {
      path: '/graphql',
      fieldResolverEnhancers: [],
      stopOnTerminationSignals: false,
    };

    // 👇 Switch to GraphiQL instead of Playground
    if (options.graphiql || options.playground) {
      const graphiQlOpts: GraphiQLOptions = typeof options.graphiql === 'object' ? options.graphiql : {};
      graphiQlOpts.url ??= options.path;

      defaults = {
        ...defaults,
        plugins: [new GraphiQLPlaygroundPlugin(graphiQlOpts)],
      };
    } else {
      // disable landing page by default
      defaults = {
        ...defaults,
        plugins: [ApolloServerPluginLandingPageDisabled()],
      };
    }

    const { plugins, ...defaultsWithoutPlugins } = defaults;
    options = await super.mergeDefaultOptions(options, defaultsWithoutPlugins);

    (options as ApolloDriverConfig).plugins = (options.plugins || []).concat(plugins || []);

    this.wrapContextResolver(options);
    this.wrapFormatErrorFn(options);
    return options;
  }

  protected async registerExpress(options: T) {
    const { path, typeDefs, resolvers, schema } = options;
    const httpAdapter = this.httpAdapterHost.httpAdapter;

    // Workaround: GraphQL playground requires body to be present
    // otherwise, it shows the "req.body is not set; this probably means you forgot to set up the json middleware before the Apollo Server middleware." error.
    // The latest version of "body-parser" does not set the body if there is no payload.
    // @see https://github.com/nestjs/graphql/issues/3451
    // @see https://github.com/nestjs/nest/pull/14443
    httpAdapter.use(path, (req: any, _: any, next: () => void) => {
      req.body = req.body ?? {};
      next();
    });

    const app = httpAdapter.getInstance();
    const drainHttpServerPlugin = ApolloServerPluginDrainHttpServer({
      httpServer: httpAdapter.getHttpServer(),
    });

    const server = new ApolloServer({
      typeDefs,
      resolvers,
      schema,
      ...options,
      plugins: (options.plugins || []).concat([drainHttpServerPlugin]),
    });

    await server.start();

    app.use(
      path,
      expressMiddleware(server, {
        context: options.context,
      }),
    );

    this.apolloServer = server;
  }

  protected async registerFastify(options: T) {
    // Extentionally added if fastify is being used
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fastifyApolloDrainPlugin, fastifyApolloHandler } = require('@as-integrations/fastify');
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const app = httpAdapter.getInstance();
    const { path, typeDefs, resolvers, schema } = options;
    const apolloDrainPlugin = fastifyApolloDrainPlugin(app);

    const server = new ApolloServer<BaseContext>({
      typeDefs,
      resolvers,
      schema,
      ...options,
      plugins: (options.plugins || []).concat([apolloDrainPlugin]),
    });

    await server.start();

    app.route({
      url: path,
      method: ['GET', 'POST', 'OPTIONS'],
      handler: fastifyApolloHandler(server, {
        context: options.context,
      }),
    });

    this.apolloServer = server;
  }

  private wrapFormatErrorFn(options: T) {
    if (options.autoTransformHttpErrors === false) {
      return;
    }
    if (options.formatError) {
      const orig = options.formatError;
      const transform = this.createTransformHttpErrorFn();
      (options as ApolloDriverConfig).formatError = (formattedError, err) => {
        formattedError = transform(formattedError, err) as GraphQLError;
        return orig(formattedError, err);
      };
    } else {
      (options as ApolloDriverConfig).formatError = this.createTransformHttpErrorFn();
    }
  }

  private createTransformHttpErrorFn() {
    return (formattedError: GraphQLFormattedError, originalError: any): GraphQLFormattedError => {
      const exceptionRef = unwrapResolverError(originalError) as any;
      const isHttpException = exceptionRef?.response?.statusCode && exceptionRef?.status;

      if (!isHttpException) {
        return formattedError;
      }

      let error: GraphQLError;
      const httpStatus = exceptionRef?.status;
      if (httpStatus in apolloPredefinedExceptions) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        error = new GraphQLError(exceptionRef?.message, {
          path: formattedError.path,
          extensions: {
            ...formattedError.extensions,
            code: apolloPredefinedExceptions[httpStatus],
          },
        });
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        error = new GraphQLError(exceptionRef.message, {
          path: formattedError.path,
          extensions: {
            ...formattedError.extensions,
            code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
            status: httpStatus,
          },
        });
      }
      if (exceptionRef?.response) {
        error.extensions['originalError'] = exceptionRef.response;
      }
      (error as any).locations = formattedError.locations;
      return error;
    };
  }

  private wrapContextResolver(
    targetOptions: ApolloDriverConfig,
    originalOptions: ApolloDriverConfig = { ...targetOptions },
  ) {
    if (!targetOptions.context) {
      targetOptions.context = async (contextOrRequest) => ({
        req: contextOrRequest.req ?? contextOrRequest,
      });
    } else if (typeof targetOptions.context === 'function') {
      targetOptions.context = async (...args: unknown[]) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        const ctx = await (originalOptions.context as Function)(...args);
        const contextOrRequest = args[0] as Record<string, unknown>;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        return this.assignReqProperty(ctx, contextOrRequest.req ?? contextOrRequest);
      };
    } else {
      targetOptions.context = async (contextOrRequest) =>
        this.assignReqProperty(
          originalOptions.context as Record<string, any>,
          contextOrRequest.req ?? contextOrRequest,
        );
    }
  }

  private assignReqProperty(ctx: Record<string, unknown> | undefined, req: unknown) {
    if (!ctx) {
      return { req };
    }
    if (typeof ctx !== 'object' || (ctx && (ctx as any).req && typeof (ctx as any).req === 'object')) {
      return ctx;
    }
    (ctx as any).req = req;
    return ctx;
  }
}
