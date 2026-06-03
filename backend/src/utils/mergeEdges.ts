import { GeneInteraction } from '@/graphql/models';
import { Edge } from '@/interfaces';

export function mergeEdgesAndAverageScore(edges: Edge[]): GeneInteraction[] {
  const edgeMap = new Map<
    string,
    {
      totalScore: number;
      count: number;
      typeScores: { [type: string]: number };
    }
  >();

  for (const edge of edges) {
    const key = edge.gene1 < edge.gene2 ? `${edge.gene1}|${edge.gene2}` : `${edge.gene2}|${edge.gene1}`;
    const type = edge.interactionType;
    const score = edge.score;

    if (edgeMap.has(key)) {
      const entry = edgeMap.get(key)!;
      entry.totalScore += score;
      entry.count++;
      entry.typeScores[type] = score;
    } else {
      edgeMap.set(key, {
        totalScore: score,
        count: 1,
        typeScores: { [type]: score },
      });
    }
  }

  return Array.from(edgeMap.entries()).map(([key, value]) => ({
    gene1: key.split('|')[0],
    gene2: key.split('|')[1],
    typeScores: value.typeScores,
    score: Number((value.totalScore / value.count).toFixed(2)),
  }));
}
