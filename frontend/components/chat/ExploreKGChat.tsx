'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import {
  ArrowRightIcon,
  BookmarkIcon,
  CheckIcon,
  ChevronDownIcon,
  DatabaseIcon,
  Loader2Icon,
  RefreshCcwIcon,
  Trash2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React from 'react';
import { toast } from 'sonner';
import { saveGraphAgentHandoffSnapshot } from '@/lib/graph-agent-handoff';
import type {
  ConversationGraphState,
  GraphAction,
  GraphAgentUIMessage,
  GraphEvidenceBundle,
} from '@/lib/graph-agent-types';
import { LLM_MODELS } from '@/lib/data';
import { generateSessionId, getUserId } from '@/lib/langfuse-tracking';
import { clearPersistedKnowledgeGraph } from '@/lib/optimuskg';
import { cn, envURL } from '@/lib/utils';
import { Checkpoint, CheckpointIcon, CheckpointTrigger } from '../ai-elements/checkpoint';
import { Conversation, ConversationContent, ConversationScrollButton } from '../ai-elements/conversation';
import {
  Message,
  MessageAction,
  MessageActions,
  MessageAttachment,
  MessageAttachments,
  MessageAvatar,
  MessageContent,
  MessageCopyAction,
  MessageResponse,
} from '../ai-elements/message';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorLogoGroup,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '../ai-elements/model-selector';
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '../ai-elements/prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '../ai-elements/reasoning';
import { Button } from '../ui/button';

type CheckpointType = {
  id: string;
  messageIndex: number;
  timestamp: Date;
  messageCount: number;
};

type PreparedTopCandidate = {
  id: string;
  displayName: string;
  typeCode: string;
  typeName: string;
  score: number;
  matchedOn: string[];
  aliases: string[];
  sourceIds: string[];
  sourceNames: string[];
  resolutionStage: 'exact' | 'alias' | 'synonym' | 'identifier' | 'semantic';
};

type ExtractedAnswerNode = {
  id: string;
  name: string;
  suggestedNodeType: string;
  confidence: number;
  kind: 'entity' | 'concept';
};

type ExploreIntent = {
  primaryGoal: string;
  focusNodeTypes: string[];
  preferredExpansionTypes: string[];
};

type ExplorePreparedCandidate = {
  id: string;
  displayName: string;
  typeCode: string;
  typeName: string;
  score: number;
  confidence: number;
  matchedOn: string[];
  aliases: string[];
  sourceIds: string[];
  sourceNames: string[];
  resolutionStage: 'exact' | 'alias' | 'synonym' | 'identifier' | 'semantic';
  candidateStage:
    | 'exact-typed'
    | 'alias-typed'
    | 'synonym-typed'
    | 'identifier-typed'
    | 'exact-any'
    | 'alias-any'
    | 'synonym-any'
    | 'identifier-any'
    | 'semantic';
  typeMatchesExpected: boolean;
};

type ExploreCandidateGroup = {
  extractedItemId: string;
  extractedName: string;
  suggestedNodeType: string;
  kind: 'entity' | 'concept';
  candidates: ExplorePreparedCandidate[];
};

type ExploreAcceptedSeed = {
  extractedItemId: string;
  extractedName: string;
  kind: 'primary' | 'related';
  id: string;
  displayName: string;
  typeCode: string;
  typeName: string;
  score: number;
  confidence: number;
  matchedOn: string[];
  candidateStage: ExplorePreparedCandidate['candidateStage'];
  typeMatchesExpected: boolean;
};

type ExploreRejectedItem = {
  extractedItemId: string;
  name: string;
  suggestedNodeType: string;
  reason: 'no_match' | 'below_threshold' | 'ambiguous' | 'deprioritized';
  detail: string;
};

type GraphBuildTelemetry = {
  extractedEntities: ExtractedAnswerNode[];
  matchedEntities: Array<Record<string, unknown>>;
  primarySeeds: ExploreAcceptedSeed[];
  relatedCandidates: ExploreAcceptedSeed[];
  resolvedSeeds: ExploreAcceptedSeed[];
  survivingSeeds: ExploreAcceptedSeed[];
  droppedSeeds: ExploreAcceptedSeed[];
  focusNodeTypes: string[];
  preferredExpansionTypes: string[];
  expansionCandidates: Array<Record<string, unknown>>;
  selectedExpansionNodes: Array<Record<string, unknown>>;
  finalNodeTypeDistribution: Array<Record<string, unknown>>;
  graphValidationResult: Record<string, unknown>;
  entitiesRejected: number;
};

type PrepareNetworkResponse = {
  preparationId: string;
  sessionId: string;
  candidateCount: number;
  topCandidates: PreparedTopCandidate[];
  extractedItems: ExtractedAnswerNode[];
  intent: ExploreIntent;
  candidateGroups: ExploreCandidateGroup[];
  primarySeeds: ExploreAcceptedSeed[];
  relatedCandidates: ExploreAcceptedSeed[];
  acceptedSeeds: ExploreAcceptedSeed[];
  rejectedItems: ExploreRejectedItem[];
  telemetry: GraphBuildTelemetry;
};

type BuildNetworkResponse = {
  sessionId: string;
  preparationId: string;
  graphEvidence: GraphEvidenceBundle;
  graphActions: GraphAction[];
  graphState: ConversationGraphState;
  seedNodeIds: string[];
};

type AssistantNetworkState = {
  status: 'preparing' | 'ready' | 'empty' | 'error' | 'building';
  query: string;
  answer: string;
  preparationId?: string;
  candidateCount: number;
  seedLabels: string[];
  extractedLabels: string[];
  debugData?: PrepareNetworkResponse;
  errorMessage?: string;
};

function JsonDebugBlock(props: { value: unknown }) {
  return (
    <pre className='overflow-x-auto rounded-lg border bg-slate-950 px-3 py-3 text-[11px] text-slate-100'>
      {JSON.stringify(props.value, null, 2)}
    </pre>
  );
}

function graphAgentApiBaseUrl() {
  const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (backendBase) {
    return envURL(backendBase);
  }

  const llmBase = envURL(process.env.NEXT_PUBLIC_LLM_BACKEND_URL);
  return llmBase.replace(/\/llm$/, '');
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${graphAgentApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(responseText || `Request failed with status ${response.status}`);
  }

  return responseText.trim().length > 0 ? (JSON.parse(responseText) as T) : (null as T);
}

function extractMessageText(message: UIMessage) {
  return message.parts
    .filter((part): part is Extract<(typeof message.parts)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function findLatestUserQuery(messages: UIMessage[], assistantMessageId: string) {
  const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId);
  if (assistantIndex === -1) {
    return '';
  }

  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') {
      continue;
    }

    const text = extractMessageText(message);
    if (text.length > 0) {
      return text;
    }
  }

  return '';
}

function toGraphAgentMessages(
  messages: UIMessage[],
  assistantMessageId: string,
  payload: BuildNetworkResponse,
): GraphAgentUIMessage[] {
  return messages.map((message) => {
    const parts = message.parts.filter(
      (part) => part.type === 'text' || part.type === 'file' || part.type === 'reasoning',
    );

    if (message.id !== assistantMessageId || message.role !== 'assistant') {
      return {
        ...message,
        parts,
      } as GraphAgentUIMessage;
    }

    return {
      ...message,
      parts: [
        ...parts,
        {
          type: 'data-graphEvidence',
          id: `graph-evidence-${payload.preparationId}`,
          data: payload.graphEvidence,
        },
        {
          type: 'data-graphActions',
          id: `graph-actions-${payload.preparationId}`,
          data: payload.graphActions,
        },
        {
          type: 'data-graphState',
          id: `graph-state-${payload.preparationId}`,
          data: {
            sessionId: payload.sessionId,
            state: payload.graphState,
          },
        },
      ],
    } as GraphAgentUIMessage;
  });
}

export function ExploreKGChat() {
  const router = useRouter();
  const [isChatOpen, setIsChatOpen] = React.useState(false);
  const [model, setModel] = React.useState<(typeof LLM_MODELS)[number]['id']>(LLM_MODELS[0].id);
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);
  const [checkpoints, setCheckpoints] = React.useState<CheckpointType[]>([]);
  const [networkByMessageId, setNetworkByMessageId] = React.useState<Record<string, AssistantNetworkState>>({});
  const [handoffState, setHandoffState] = React.useState<{ message: string } | null>(null);
  const [, startRouteTransition] = React.useTransition();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const preparedAssistantIds = React.useRef(new Set<string>());
  const messagesRef = React.useRef<UIMessage[]>([]);

  const sessionId = React.useMemo(() => generateSessionId(), []);

  const { messages, setMessages, sendMessage, status, regenerate, stop, clearError } = useChat({
    transport: new DefaultChatTransport({
      api: `${envURL(process.env.NEXT_PUBLIC_LLM_BACKEND_URL)}/chat`,
    }),
    onError(error) {
      toast.error('Failed to fetch response from LLM', {
        cancel: { label: 'Close', onClick() {} },
        description: error.message || 'LLM server is not responding. Please try again later.',
      });
    },
  });

  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const createCheckpoint = React.useCallback((messageIndex: number) => {
    const checkpoint: CheckpointType = {
      id: `checkpoint-${Date.now()}-${messageIndex}`,
      messageIndex,
      timestamp: new Date(),
      messageCount: messageIndex + 1,
    };
    setCheckpoints((prev) => [...prev, checkpoint]);
  }, []);

  const restoreToCheckpoint = React.useCallback(
    (messageIndex: number) => {
      setMessages(messages.slice(0, messageIndex + 1));
      setCheckpoints((prev) => prev.filter((cp) => cp.messageIndex <= messageIndex));
      toast.success('Checkpoint restored', {
        description: `Conversation restored to ${messageIndex + 1} messages`,
      });
    },
    [messages, setMessages],
  );

  React.useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (status !== 'ready' || lastMessage?.role !== 'assistant') {
      return;
    }

    if (checkpoints.some((checkpoint) => checkpoint.messageIndex === messages.length - 1)) {
      return;
    }

    createCheckpoint(messages.length - 1);
  }, [checkpoints, createCheckpoint, messages, status]);

  const prepareAnswerNetwork = React.useCallback(
    async (assistantMessageId: string, query: string, answer: string) => {
      try {
        const payload = await postJson<PrepareNetworkResponse>('/graph-agent/explore/prepare-network', {
          model,
          sessionId,
          query,
          answer,
        });

        setNetworkByMessageId((prev) => ({
          ...prev,
          [assistantMessageId]: {
            ...prev[assistantMessageId],
            status: payload.primarySeeds.length > 0 ? 'ready' : 'empty',
            preparationId: payload.preparationId,
            candidateCount: payload.candidateCount,
            seedLabels: payload.primarySeeds.map((candidate) => candidate.displayName).slice(0, 4),
            extractedLabels: payload.extractedItems.map((node) => node.name).slice(0, 4),
            debugData: payload,
            errorMessage: undefined,
          },
        }));
      } catch (error) {
        setNetworkByMessageId((prev) => ({
          ...prev,
          [assistantMessageId]: {
            ...prev[assistantMessageId],
            status: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to prepare network.',
          },
        }));
      }
    },
    [model, sessionId],
  );

  React.useEffect(() => {
    if (status === 'submitted' || status === 'streaming' || status === 'error') {
      return;
    }

    const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    if (!latestAssistant || preparedAssistantIds.current.has(latestAssistant.id)) {
      return;
    }

    const answer = extractMessageText(latestAssistant);
    const query = findLatestUserQuery(messages, latestAssistant.id);
    if (answer.length === 0 || query.length === 0) {
      return;
    }

    preparedAssistantIds.current.add(latestAssistant.id);
    setNetworkByMessageId((prev) => ({
      ...prev,
      [latestAssistant.id]: {
        status: 'preparing',
        query,
        answer,
        candidateCount: 0,
        seedLabels: [],
        extractedLabels: [],
        debugData: undefined,
      },
    }));
    void prepareAnswerNetwork(latestAssistant.id, query, answer);
  }, [messages, prepareAnswerNetwork, status]);

  const handleSubmit = async (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);

    if (!(hasText || hasAttachments)) {
      return;
    }

    setIsChatOpen(true);
    sendMessage(
      { text: message.text, files: message.files },
      {
        body: {
          model,
          sessionId,
          userId: getUserId(),
        },
      },
    );
  };

  const handleDeleteMessages = () => {
    setMessages([]);
    setCheckpoints([]);
    setNetworkByMessageId({});
    preparedAssistantIds.current.clear();
    setIsChatOpen(false);
  };

  const handleSubmitAction = () => {
    if (status === 'submitted' || status === 'streaming') {
      stop();
    } else if (status === 'error') {
      setMessages(messages.slice(0, -1));
      clearError();
    }
  };

  const handleBuildNetwork = React.useCallback(
    async (assistantMessageId: string) => {
      const prepared = networkByMessageId[assistantMessageId];
      if (!prepared?.preparationId) {
        return;
      }

      setNetworkByMessageId((prev) => ({
        ...prev,
        [assistantMessageId]: {
          ...prev[assistantMessageId],
          status: 'building',
          errorMessage: undefined,
        },
      }));
      setHandoffState({ message: 'Loading the prepared graph...' });

      try {
        const payload = await postJson<BuildNetworkResponse>('/graph-agent/explore/build-network', {
          preparationId: prepared.preparationId,
          sessionId,
        });

        await clearPersistedKnowledgeGraph();

        const graphMessages = toGraphAgentMessages(messagesRef.current, assistantMessageId, payload);
        saveGraphAgentHandoffSnapshot({
          createdAt: new Date().toISOString(),
          sourceRoute: '/explore',
          sessionId: payload.sessionId,
          model,
          messages: graphMessages,
        });

        startRouteTransition(() => {
          window.open('/knowledge-graph', '_blank');
        
        });
      } catch (error) {
        setHandoffState(null);
        setNetworkByMessageId((prev) => ({
          ...prev,
          [assistantMessageId]: {
            ...prev[assistantMessageId],
            status: 'ready',
            errorMessage: error instanceof Error ? error.message : 'Failed to build network.',
          },
        }));
        toast.error('Failed to build the knowledge graph', {
          cancel: { label: 'Close', onClick() {} },
          description: error instanceof Error ? error.message : 'Network construction failed.',
        });
      }
    },
    [model, networkByMessageId, router, sessionId],
  );

  const renderPreparedNetworkAction = (message: UIMessage) => {
    if (message.role !== 'assistant') {
      return null;
    }

    const prepared = networkByMessageId[message.id];
    if (!prepared) {
      return null;
    }

    if (prepared.status === 'preparing') {
      return (
        <div className='mt-2 ml-10 flex items-center gap-2 text-slate-500 text-xs'>
          <Loader2Icon className='size-3 animate-spin' />
          Preparing network candidates from the answer...
        </div>
      );
    }

    if (prepared.status === 'error') {
      return (
        <div className='mt-2 ml-10 text-amber-700 text-xs'>
          {prepared.errorMessage || 'Network preparation failed for this answer.'}
        </div>
      );
    }

    if (prepared.status === 'empty') {
      const extractedSummary =
        prepared.extractedLabels.length > 0
          ? `Extracted: ${prepared.extractedLabels.join(', ')}.`
          : 'No graph-ready biomedical entities were extracted from this answer.';
      return (
        <div className='mt-2 ml-10 space-y-2 text-xs'>
          <div className='text-slate-500'>{extractedSummary}</div>
          {prepared.debugData && renderDebugPanel(prepared.debugData)}
        </div>
      );
    }

    const seedSummary =
      prepared.seedLabels.length > 0
        ? prepared.seedLabels.join(', ')
        : `${prepared.candidateCount} prepared candidate${prepared.candidateCount === 1 ? '' : 's'}`;

    return (
      <div className='mt-3 ml-10 space-y-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            type='button'
            onClick={() => void handleBuildNetwork(message.id)}
            disabled={prepared.status === 'building'}
            className='bg-sky-700 text-white hover:bg-sky-800'
          >
            {prepared.status === 'building' ? (
              <Loader2Icon className='size-4 animate-spin' />
            ) : (
              <DatabaseIcon className='size-4' />
            )}
            View Network
            <ArrowRightIcon className='size-4' />
          </Button>
          <span className='text-slate-500 text-xs'>Prepared from {seedSummary}</span>
        </div>
        {prepared.debugData && renderDebugPanel(prepared.debugData)}
      </div>
    );
  };

  const renderDebugPanel = (payload: PrepareNetworkResponse) => {
    const candidateSearchResults = Object.fromEntries(
      payload.candidateGroups.map((group) => [
        group.extractedName,
        group.candidates.map((candidate) => ({
          label: candidate.displayName,
          type: candidate.typeName,
          score: candidate.confidence,
          stage: candidate.candidateStage,
          matchedOn: candidate.matchedOn,
        })),
      ]),
    );

    return (
      <Collapsible className='rounded-lg border border-slate-200/80 bg-slate-50'>
        <CollapsibleTrigger className='flex w-full items-center justify-between px-3 py-2 text-left text-slate-700 text-xs hover:bg-slate-100'>
          <span>Preparation Debug</span>
          <ChevronDownIcon className='size-4' />
        </CollapsibleTrigger>
        <CollapsibleContent className='space-y-3 border-slate-200 border-t px-3 py-3'>
          <div className='space-y-1'>
            <div className='font-medium text-[11px] uppercase tracking-wide text-slate-500'>LLM Extracted</div>
            <JsonDebugBlock value={payload.extractedItems} />
          </div>
          <div className='space-y-1'>
            <div className='font-medium text-[11px] uppercase tracking-wide text-slate-500'>Intent</div>
            <JsonDebugBlock value={payload.intent} />
          </div>
          <div className='space-y-1'>
            <div className='font-medium text-[11px] uppercase tracking-wide text-slate-500'>Candidate Search Results</div>
            <JsonDebugBlock value={candidateSearchResults} />
          </div>
          <div className='space-y-1'>
            <div className='font-medium text-[11px] uppercase tracking-wide text-slate-500'>Primary Seeds</div>
            <JsonDebugBlock value={payload.primarySeeds} />
          </div>
          <div className='space-y-1'>
            <div className='font-medium text-[11px] uppercase tracking-wide text-slate-500'>Related Candidates</div>
            <JsonDebugBlock value={payload.relatedCandidates} />
          </div>
          <div className='space-y-1'>
            <div className='font-medium text-[11px] uppercase tracking-wide text-slate-500'>Rejected Entities</div>
            <JsonDebugBlock value={payload.rejectedItems} />
          </div>
          <div className='space-y-1'>
            <div className='font-medium text-[11px] uppercase tracking-wide text-slate-500'>Graph Build Telemetry</div>
            <JsonDebugBlock value={payload.telemetry} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  const renderMessages = () => (
    <Conversation className='h-full'>
      <ConversationContent>
        {messages.map((message, messageIndex) => {
          const checkpoint = checkpoints.find((cp) => cp.messageIndex === messageIndex);
          const hasAttachments = message.parts.some((part) => part.type === 'file');

          return (
            <React.Fragment key={message.id}>
              <div className='fade-in slide-in-from-bottom-10 animate-in duration-300'>
                {hasAttachments && (
                  <MessageAttachments className='mb-2'>
                    {message.parts
                      .filter((part) => part.type === 'file')
                      .map((part, index) => (
                        <MessageAttachment key={`${message.id}-attachment-${index}`} data={part} />
                      ))}
                  </MessageAttachments>
                )}

                {message.parts.map((part, index) => {
                  switch (part.type) {
                    case 'text':
                      return (
                        <React.Fragment key={`${message.id}-${index}`}>
                          <Message from={message.role}>
                            <MessageContent className='shadow-md'>
                              <MessageResponse
                                isAnimating={status !== 'ready' && message.role === 'assistant' && message.id === messages.at(-1)?.id}
                              >
                                {part.text}
                              </MessageResponse>
                            </MessageContent>
                            <MessageAvatar
                              className={cn('shadow', message.role === 'assistant' && 'p-1')}
                              src={message.role === 'user' ? '/image/user.png' : '/image/logo.svg'}
                              name={message.role === 'user' ? 'You' : 'AI'}
                            />
                          </Message>
                          {message.role === 'assistant' && (
                            <MessageActions className='-mt-2 pl-10'>
                              {messages.length - 1 === messageIndex && (
                                <MessageAction onClick={() => regenerate()} label='Retry'>
                                  <RefreshCcwIcon className='size-3' />
                                </MessageAction>
                              )}
                              <MessageCopyAction text={part.text} />
                              {!checkpoint && (
                                <MessageAction
                                  onClick={() => createCheckpoint(messageIndex)}
                                  label='Checkpoint'
                                  tooltip='Save this point'
                                >
                                  <BookmarkIcon className='size-3' />
                                </MessageAction>
                              )}
                            </MessageActions>
                          )}
                          {message.role === 'assistant' && renderPreparedNetworkAction(message)}
                        </React.Fragment>
                      );
                    case 'reasoning':
                      return (
                        <Reasoning
                          key={`${message.id}-${index}`}
                          className='w-full'
                          isStreaming={
                            status === 'streaming' &&
                            index === message.parts.length - 1 &&
                            message.id === messages.at(-1)?.id
                          }
                        >
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      );
                    case 'file':
                      return null;
                    default:
                      return null;
                  }
                })}
              </div>

              {checkpoint && (
                <Checkpoint className='my-4'>
                  <CheckpointIcon />
                  <CheckpointTrigger onClick={() => restoreToCheckpoint(checkpoint.messageIndex)}>
                    Restore checkpoint ({checkpoint.messageCount} messages)
                  </CheckpointTrigger>
                </Checkpoint>
              )}
            </React.Fragment>
          );
        })}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );

  const selectedModelData = LLM_MODELS.find((entry) => entry.id === model);

  const renderPromptInput = () => (
    <PromptInputProvider>
      <PromptInput globalDrop multiple onSubmit={handleSubmit} className='mx-2'>
        <PromptInputAttachments>{(attachment) => <PromptInputAttachment data={attachment} />}</PromptInputAttachments>
        <PromptInputBody>
          <PromptInputTextarea ref={textareaRef} disabled={status === 'error'} />
        </PromptInputBody>
        <PromptInputFooter>
          <PromptInputTools>
            <PromptInputActionMenu>
              <PromptInputActionMenuTrigger />
              <PromptInputActionMenuContent>
                <PromptInputActionAddAttachments />
              </PromptInputActionMenuContent>
            </PromptInputActionMenu>
            <PromptInputSpeechButton textareaRef={textareaRef} />
            <ModelSelector onOpenChange={setModelSelectorOpen} open={modelSelectorOpen}>
              <ModelSelectorTrigger asChild>
                <PromptInputButton>
                  {selectedModelData?.chefSlug && <ModelSelectorLogo provider={selectedModelData.chefSlug} />}
                  {selectedModelData && <ModelSelectorName>{selectedModelData.name}</ModelSelectorName>}
                </PromptInputButton>
              </ModelSelectorTrigger>
              <ModelSelectorContent>
                <ModelSelectorInput placeholder='Search models...' />
                <ModelSelectorList>
                  <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                  {['OpenAI', 'DeepSeek AI', 'Meta'].map((chef) => (
                    <ModelSelectorGroup heading={chef} key={chef}>
                      {LLM_MODELS.filter((entry) => entry.chef === chef).map((entry) => (
                        <ModelSelectorItem
                          key={entry.id}
                          onSelect={() => {
                            setModel(entry.id);
                            setModelSelectorOpen(false);
                          }}
                          value={entry.id}
                        >
                          <ModelSelectorLogo provider={entry.chefSlug} />
                          <ModelSelectorName>{entry.name}</ModelSelectorName>
                          <ModelSelectorLogoGroup>
                            {entry.providers.map((provider) => (
                              <ModelSelectorLogo key={provider} provider={provider} />
                            ))}
                          </ModelSelectorLogoGroup>
                          {model === entry.id ? <CheckIcon className='ml-auto size-4' /> : <div className='ml-auto size-4' />}
                        </ModelSelectorItem>
                      ))}
                    </ModelSelectorGroup>
                  ))}
                </ModelSelectorList>
              </ModelSelectorContent>
            </ModelSelector>
          </PromptInputTools>
          <PromptInputSubmit status={status} onClick={handleSubmitAction} />
        </PromptInputFooter>
      </PromptInput>
    </PromptInputProvider>
  );

  return (
    <>
      <div className='mt-4 flex flex-col rounded-lg border p-4 shadow-md'>
        {isChatOpen && (
          <div className='space-y-2 p-2'>
            <div className='fade-in animate-in duration-200'>
              <div className='flex justify-between border-b pb-2'>
                Explore Assistant
                <button type='button' onClick={handleDeleteMessages} className='text-gray-500 hover:text-gray-700'>
                  <Trash2Icon className='size-5' />
                </button>
              </div>
              {renderMessages()}
            </div>
          </div>
        )}
        <div className='mt-2 flex'>{renderPromptInput()}</div>
        <div className='mt-2 flex'>
          <center className='ml-0.5 text-gray-500 text-sm'>
            This AI assistant may occasionally generate incorrect or misleading information. We are not responsible for
            any decisions made based on the generated content. By using this service, you agree to our{' '}
            <Link href='/docs/terms-of-use' className='font-medium underline underline-offset-4 hover:text-primary'>
              Terms of Use
            </Link>{' '}
            and{' '}
            <Link href='/docs/privacy-policy' className='font-medium underline underline-offset-4 hover:text-primary'>
              Privacy Policy
            </Link>
            .
          </center>
        </div>
      </div>
      {handoffState && (
        <div className='fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/65 backdrop-blur-sm'>
          <div className='flex min-w-[280px] flex-col items-center gap-3 rounded-2xl border border-sky-200/20 bg-slate-900 px-8 py-7 text-center text-white shadow-2xl'>
            <Loader2Icon className='size-8 animate-spin text-sky-300' />
            <div className='font-semibold text-lg'>Loading Knowledge Graph</div>
            <div className='text-sm text-slate-300'>{handoffState.message}</div>
          </div>
        </div>
      )}
    </>
  );
}
