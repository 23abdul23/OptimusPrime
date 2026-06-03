import { GeneBase, GeneInteraction } from '.';
import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class GeneInteractionOutput {
  @Field(() => [GeneBase])
  genes: GeneBase[];

  @Field(() => [GeneInteraction], { nullable: true })
  links: GeneInteraction[];

  @Field(() => String, { nullable: true })
  graphName?: string;

  @Field(() => Number, { nullable: true })
  averageClusteringCoefficient?: number;
}
