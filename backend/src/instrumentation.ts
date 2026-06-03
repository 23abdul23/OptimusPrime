import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

let langfuseSpanProcessor: LangfuseSpanProcessor | null = null;

/**
 * Initialize Langfuse tracing with OpenTelemetry
 * This should be called early in the application lifecycle, after ConfigService is available
 */
export function initializeLangfuseTracing(configService: ConfigService): void {
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');

  // Only enable Langfuse tracing in production
  if (nodeEnv !== 'production') {
    Logger.warn('Tracing disabled (NODE_ENV is not production)', 'Langfuse');
    return;
  }

  const secretKey = configService.get<string>('LANGFUSE_SECRET_KEY');
  const publicKey = configService.get<string>('LANGFUSE_PUBLIC_KEY');
  const baseUrl = configService.get<string>('LANGFUSE_BASE_URL', 'https://us.cloud.langfuse.com');

  // Check if required credentials are provided
  if (!secretKey || !publicKey) {
    Logger.warn('Tracing not initialized: Missing LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY', 'Langfuse');
    return;
  }
  try {
    // Initialize the Langfuse span processor with credentials from ConfigService
    langfuseSpanProcessor = new LangfuseSpanProcessor({
      secretKey,
      publicKey,
      baseUrl,
    });

    const tracerProvider = new NodeTracerProvider({
      spanProcessors: [langfuseSpanProcessor],
    });

    // Register the tracer provider globally
    tracerProvider.register();

    Logger.log('Tracing initialized successfully', 'Langfuse');
  } catch (error) {
    Logger.error('Failed to initialize tracing:', error, 'Langfuse');
  }
}

/**
 * Get the Langfuse span processor instance (for flushing in serverless environments)
 */
export function getLangfuseSpanProcessor(): LangfuseSpanProcessor | null {
  return langfuseSpanProcessor;
}
