import { Module } from '@nestjs/common';
import { AlgorithmService } from './algorithm.service';
import { AlgorithmController } from './algorithm.controller';

@Module({
  providers: [AlgorithmService],
  controllers: [AlgorithmController],
})
export class AlgorithmModule {}
