import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MODEL_ID_LIST } from '@/llm/model.constants';

export const GraphAgentChatRequestSchema = z.object({
  model: z.enum(MODEL_ID_LIST).optional(),
  messages: z.array(z.any()).optional(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
  selectedNodeContext: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        nodeType: z.string().optional(),
      }),
    )
    .optional(),
  selectedEdgeContext: z
    .array(
      z.object({
        id: z.string(),
        source: z.string(),
        target: z.string(),
        relation: z.string().optional(),
      }),
    )
    .optional(),
  networkContext: z
    .object({
      totalNodes: z.number().int().nonnegative(),
      totalEdges: z.number().int().nonnegative(),
      selectedNodeIds: z.array(z.string()).optional(),
      selectedEdgeIds: z.array(z.string()).optional(),
      visibleNodeIds: z.array(z.string()).optional(),
      visibleEdgeIds: z.array(z.string()).optional(),
      visibleNodeContext: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            nodeType: z.string().optional(),
          }),
        )
        .optional(),
      topNodeTypes: z
        .array(
          z.object({
            type: z.string(),
            count: z.number().int().nonnegative(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export class GraphAgentChatRequestDto extends createZodDto(GraphAgentChatRequestSchema) {}

export const ExploreAnswerNetworkPrepareSchema = z.object({
  model: z.enum(MODEL_ID_LIST).optional(),
  sessionId: z.string().min(1).optional(),
  query: z.string().min(1),
  answer: z.string().min(1),
});

export class ExploreAnswerNetworkPrepareDto extends createZodDto(ExploreAnswerNetworkPrepareSchema) {}

export const ExploreAnswerNetworkBuildSchema = z.object({
  sessionId: z.string().min(1).optional(),
  preparationId: z.string().min(1),
});

export class ExploreAnswerNetworkBuildDto extends createZodDto(ExploreAnswerNetworkBuildSchema) {}
