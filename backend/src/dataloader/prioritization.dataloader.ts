import { Injectable, Logger } from '@nestjs/common';
import DataLoader from 'dataloader';
import { ClickhouseService } from '@/clickhouse/clickhouse.service';
import { ScoredKeyValue } from '@/graphql/models';

@Injectable()
export class PrioritizationDataLoader {
  private readonly logger = new Logger(PrioritizationDataLoader.name);

  constructor(private readonly clickhouseService: ClickhouseService) {}

  createLoader(): DataLoader<string, ScoredKeyValue[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return new DataLoader<string, ScoredKeyValue[]>(this.batchLoadPrioritization.bind(this), {
      cache: true,
      maxBatchSize: 100,
      name: PrioritizationDataLoader.name,
    });
  }

  private async batchLoadPrioritization(geneIds: readonly string[]): Promise<ScoredKeyValue[][]> {
    try {
      // Use the efficient batch method from ClickhouseService
      const resultMap = await this.clickhouseService.getBatchPrioritizationTable(Array.from(geneIds));

      // Return results in the same order as requested gene IDs
      return geneIds.map((geneId) => resultMap.get(geneId) || []);
    } catch (error) {
      this.logger.error('Batch prioritization query failed:', error);
      throw error;
    }
  }
}
