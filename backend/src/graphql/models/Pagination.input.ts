import { Field, InputType, Int } from '@nestjs/graphql';

@InputType()
export class Pagination {
  @Field(() => Int, { defaultValue: 1, nullable: true })
  page: number;

  @Field(() => Int, { defaultValue: 25, nullable: true })
  limit: number;
}
