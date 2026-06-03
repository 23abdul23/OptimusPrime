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
      }),
    )
    .optional(),
  networkContext: z
    .object({
      totalNodes: z.number().int().nonnegative(),
      totalEdges: z.number().int().nonnegative(),
      selectedNodeIds: z.array(z.string()).optional(),
    })
    .optional(),
});

export class GraphAgentChatRequestDto extends createZodDto(GraphAgentChatRequestSchema) {}
