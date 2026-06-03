import { Body, Controller, HttpException, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { observe, updateActiveTrace } from '@langfuse/tracing';
import { pipeUIMessageStreamToResponse } from 'ai';
import { DEFAULT_MODEL } from '@/llm/model.constants';
import { ThrottlerBehindProxyGuard } from '@/llm/llm-throttle.guard';
import { GraphAgentChatRequestDto } from './graph-agent.dto';
import { GraphAgentService } from './graph-agent.service';

@Controller('graph-agent')
export class GraphAgentController {
  constructor(private readonly graphAgentService: GraphAgentService) {}

  @Post('chat')
  @UseGuards(ThrottlerBehindProxyGuard)
  async streamChat(@Body() promptDto: GraphAgentChatRequestDto, @Res() res: Response) {
    return observe(
      async () => {
        try {
          updateActiveTrace({
            name: 'graph-agent-chat-request',
            userId: promptDto.userId,
            sessionId: promptDto.sessionId,
            metadata: {
              model: promptDto.model || DEFAULT_MODEL,
              messageCount: promptDto.messages?.length || 0,
              selectedNodes: promptDto.selectedNodeContext?.length || 0,
            },
          });

          const stream = this.graphAgentService.createChatStream(promptDto);
          return pipeUIMessageStreamToResponse({
            response: res,
            stream,
            status: HttpStatus.OK,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to stream graph-agent response';
          throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
        }
      },
      {
        name: 'handle-graph-agent-chat',
        captureInput: true,
        captureOutput: false,
        endOnExit: false,
      },
    )();
  }
}
