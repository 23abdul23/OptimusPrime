import { Injectable, Scope } from '@nestjs/common';
import DataLoader from 'dataloader';
import { PrioritizationDataLoader } from './prioritization.dataloader';
import { ScoredKeyValue } from '@/graphql/models';

@Injectable({ scope: Scope.REQUEST })
export class DataLoaderService {
  private prioritizationLoader: DataLoader<string, ScoredKeyValue[]>;

  constructor(private readonly prioritizationDataLoader: PrioritizationDataLoader) {}

  getPrioritizationLoader(): DataLoader<string, ScoredKeyValue[]> {
    if (!this.prioritizationLoader) {
      this.prioritizationLoader = this.prioritizationDataLoader.createLoader();
    }
    return this.prioritizationLoader;
  }
}
