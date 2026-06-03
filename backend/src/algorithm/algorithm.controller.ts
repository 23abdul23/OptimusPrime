import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  ParseBoolPipe,
  ParseFloatPipe,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AlgorithmService } from '@/algorithm/algorithm.service';
import { GraphConfigDto } from '@/algorithm/algorithm.dto';

@Controller('algorithm')
export class AlgorithmController {
  constructor(private readonly algoService: AlgorithmService) {}

  @Get('leiden')
  async leiden(
    @Query('graphName') graphName: string,
    @Query('resolution', new ParseFloatPipe({ optional: true })) resolution = 1,
    @Query('weighted', new ParseBoolPipe({ optional: true })) weighted = true,
    @Query('minCommunitySize', new ParseIntPipe({ optional: true })) minCommunitySize = 1,
  ) {
    const result = await this.algoService.leiden(graphName, resolution, weighted, minCommunitySize);
    if (!result) throw new HttpException('Graph not found', HttpStatus.NOT_FOUND);
    return result;
  }

  @Post('renew-session')
  @HttpCode(HttpStatus.ACCEPTED)
  async renewSession(@Body() graphConfig: GraphConfigDto) {
    if (await this.algoService.renewSession(graphConfig)) return;
    throw new HttpException('Graph already exists', HttpStatus.CONFLICT);
  }
}
