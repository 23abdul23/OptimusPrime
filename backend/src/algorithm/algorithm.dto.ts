import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const GraphConfigDtoSchema = z.object({
  graphName: z.string().min(1, 'Graph name cannot be empty'),
  geneIDs: z.array(z.string()).min(1, 'At least one gene ID is required'),
  diseaseMap: z.string().min(1, 'Disease map cannot be empty'),
  order: z.number().min(0, 'Order must be at least 0').max(2, 'Order cannot be greater than 2'),
  interactionType: z.array(z.string()).min(1, 'At least one interaction type is required'),
  minScore: z.number().min(0, 'Min score must be at least 0').max(1, 'Min score cannot be greater than 1'),
});

export class GraphConfigDto extends createZodDto(GraphConfigDtoSchema) {}
