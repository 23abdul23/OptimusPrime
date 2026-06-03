import { Module } from '@nestjs/common';
import { PrioritizationDataLoader } from './prioritization.dataloader';
import { DataLoaderService } from './dataloader.service';
import { ClickhouseModule } from '@/clickhouse/clickhouse.module';

@Module({
  imports: [ClickhouseModule],
  providers: [PrioritizationDataLoader, DataLoaderService],
  exports: [DataLoaderService],
})
export class DataLoaderModule {}
