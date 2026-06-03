import { Field, ObjectType, ID } from '@nestjs/graphql';

@ObjectType()
export class GeneMetadata {
  @Field(() => ID)
  ID: string;

  @Field(() => String)
  Input: string;

  @Field(() => String, { nullable: true })
  Description?: string;

  @Field(() => String, { nullable: true })
  Gene_name?: string;

  @Field(() => String, { nullable: true })
  hgnc_gene_id?: string;

  @Field(() => String, { nullable: true })
  Aliases?: string;
}
