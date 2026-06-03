import { Field, InputType } from '@nestjs/graphql';
import { GenePropertyCategoryEnum } from './GeneProperty.model';

@InputType()
export class DataRequired {
  @Field(() => String, { nullable: true })
  diseaseId?: string;

  @Field(() => GenePropertyCategoryEnum)
  category: GenePropertyCategoryEnum;

  @Field(() => [String])
  properties: string[];
}
