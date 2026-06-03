import { ClickhouseService } from '@/clickhouse/clickhouse.service';
import { DataLoaderService } from '@/dataloader';
import { Args, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
  DataRequired,
  GeneProperty,
  OrderByEnum,
  ScoredKeyValue,
  Target,
  TargetDiseaseAssociationTable,
  TopGene,
} from './models';
import { Pagination } from './models/Pagination.input';

@Resolver()
export class ClickhouseResolver {
  constructor(private readonly clickhouseService: ClickhouseService) {}

  @Query(() => [TopGene])
  async topGenesByDisease(
    @Args('diseaseId', { type: () => String }) diseaseId: string,
    @Args('limit', { type: () => Int, defaultValue: 25 }) limit: number,
  ): Promise<TopGene[]> {
    return this.clickhouseService.getTopGenesByDisease(diseaseId, limit);
  }

  @Query(() => TargetDiseaseAssociationTable)
  async targetDiseaseAssociationTable(
    @Args('geneIds', { type: () => [String] }) geneIds: string[],
    @Args('diseaseId', { type: () => String }) diseaseId: string,
    @Args('orderBy', {
      type: () => OrderByEnum,
      defaultValue: OrderByEnum.SCORE,
      nullable: true,
    })
    orderBy: OrderByEnum,
    @Args('page', { type: () => Pagination, nullable: true })
    pagination?: Pagination,
  ) {
    return this.clickhouseService.getTargetDiseaseAssociationTable(geneIds, diseaseId, orderBy, pagination);
  }

  @Query(() => TargetDiseaseAssociationTable)
  async targetPrioritizationTable(
    @Args('geneIds', { type: () => [String] }) geneIds: string[],
    @Args('diseaseId', { type: () => String }) diseaseId: string,
    @Args('page', { type: () => Pagination, nullable: true })
    pagination?: Pagination,
  ) {
    return this.clickhouseService.getTargetPrioritizationTable(geneIds, diseaseId, pagination);
  }

  @Query(() => [GeneProperty])
  async geneProperties(
    @Args('geneIds', { type: () => [String] }) geneIds: string[],
    @Args('config', { type: () => [DataRequired] }) config: DataRequired[],
  ) {
    return this.clickhouseService.getGeneProperties(geneIds, config);
  }
}

@Resolver(() => Target)
export class TargetResolver {
  constructor(private readonly dataLoaderService: DataLoaderService) {}

  @ResolveField('prioritization', () => [ScoredKeyValue])
  async prioritizationTable(@Parent() target: Target) {
    const prioritizationLoader = this.dataLoaderService.getPrioritizationLoader();
    return prioritizationLoader.load(target.id);
  }
}
