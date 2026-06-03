import { Field, InputType, Float } from '@nestjs/graphql';

@InputType()
export class InteractionInput {
  @Field(() => [String])
  geneIDs: string[];

  @Field(() => String, { nullable: true })
  graphName?: string;

  @Field(() => [String])
  interactionType: string[];

  @Field(() => Float)
  minScore: number;
}
