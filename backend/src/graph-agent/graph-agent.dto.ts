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
      visibleNodeIds: z.array(z.string()).optional(),
      visibleEdgeIds: z.array(z.string()).optional(),
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
