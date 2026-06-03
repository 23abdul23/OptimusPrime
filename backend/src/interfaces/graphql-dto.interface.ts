import type { GeneBase } from '@/graphql/models';

export interface Disease {
  ID: string;
  name?: string;
}

export interface Edge {
  gene1: string;
  gene2: string;
  score: number;
  interactionType: string;
}

export class GeneInteractionQueryOutput {
  genes: GeneBase[];

  links: Edge[];

  graphName?: string;

  averageClusteringCoefficient?: number;
}
