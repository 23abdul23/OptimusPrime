import { Field, Float, ObjectType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-type-json';

@ObjectType()
export class GeneInteraction {
  @Field(() => String)
  gene1: string;

  @Field(() => String)
  gene2: string;

  @Field(() => Float)
  score: number;

  @Field(() => GraphQLJSON, { nullable: true })
  typeScores?: Record<string, number>;
}
