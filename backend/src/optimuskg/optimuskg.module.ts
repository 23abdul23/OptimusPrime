import { Module } from '@nestjs/common';
import { OptimusKgController } from './optimuskg.controller';
import { OptimusKgService } from './optimuskg.service';

@Module({
  controllers: [OptimusKgController],
  providers: [OptimusKgService],
  exports: [OptimusKgService],
})
export class OptimusKgModule {}
