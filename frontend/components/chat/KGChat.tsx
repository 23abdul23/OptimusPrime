'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { BookmarkIcon, BugIcon, CheckIcon, RefreshCcwIcon } from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';
import { LLM_MODELS } from '@/lib/data';
import type {
  GraphAction,
  GraphAgentUIMessage,
  ConversationGraphState,
  GraphEvidenceBundle,
  GraphNetworkContext,
  GraphSelectionEdgeContext,
  GraphSelectionNodeContext,
} from '@/lib/graph-agent-types';
import { useKGStore } from '@/lib/hooks/use-kg-store';
import { generateSessionId, getUserId } from '@/lib/langfuse-tracking';
import {
  applyOptimusGraph,
  focusOptimusNodes,
  highlightOptimusPath,
} from '@/lib/optimuskg';
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

type CheckpointType = {
  id: string;
  messageIndex: number;
  timestamp: Date;
  messageCount: number;
};

type GraphAgentPart = GraphAgentUIMessage['parts'][number];
type GraphEvidencePart = { type: 'data-graphEvidence'; id?: string; data: GraphEvidenceBundle };
type GraphActionsPart = { type: 'data-graphActions'; id?: string; data: GraphAction[] };
type GraphStatePart = {
  type: 'data-graphState';
  id?: string;
  data: {
    sessionId: string;
    state: ConversationGraphState;
  };
};

type GraphAgentDebugPayload = {
  query: string;
  model: string;
  sessionId: string;
  selectedNodeContext: GraphSelectionNodeContext[];
  selectedEdgeContext: GraphSelectionEdgeContext[];
  networkContext?: GraphNetworkContext;
  createdAt: string;
};

const GRAPH_AGENT_DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.NEXT_PUBLIC_GRAPH_AGENT_DEBUG ?? '',
);

function sanitizeMessageParts(parts: GraphAgentPart[]): GraphAgentPart[] {
  return parts.filter((part) => part.type === 'text' || part.type === 'file');
}

function buildMinimalGraphAgentMessages(messages: GraphAgentUIMessage[]): GraphAgentUIMessage[] {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');

  if (!latestUserMessage) {
    return [];
  }

  return [
    {
      ...latestUserMessage,
      parts: sanitizeMessageParts(latestUserMessage.parts),
    },
  ];
}

function isGraphEvidencePart(part: GraphAgentPart): part is GraphEvidencePart {
  return part.type === 'data-graphEvidence';
}

function isGraphActionsPart(part: GraphAgentPart): part is GraphActionsPart {
  return part.type === 'data-graphActions';
}

function isGraphStatePart(part: GraphAgentPart): part is GraphStatePart {
  return part.type === 'data-graphState';
}

function graphAgentApiBaseUrl() {
  const backendBase = process.env.NEXT_PUBLIC_BACKEND_URL;
  if (backendBase) {
    return envURL(backendBase);
  }

  const llmBase = envURL(process.env.NEXT_PUBLIC_LLM_BACKEND_URL);
  return llmBase.replace(/\/llm$/, '');
}

export interface KGChatProps {
  onChatOpen?: (isOpen: boolean) => void;
  children?: (props: KGChatRenderProps) => React.ReactNode;
}

export interface KGChatRenderProps {
  model: string;
  messages: ReturnType<typeof useChat<GraphAgentUIMessage>>['messages'];
  status: ReturnType<typeof useChat<GraphAgentUIMessage>>['status'];
  checkpoints: CheckpointType[];
  handleSubmit: (message: PromptInputMessage) => Promise<void>;
  handleDeleteMessages: () => void;
  handleSubmitAction: () => void;
  setModel: (model: (typeof LLM_MODELS)[number]['id']) => void;
  regenerate: () => void;
  createCheckpoint: (messageIndex: number) => void;
  restoreToCheckpoint: (messageIndex: number) => void;
  renderMessages: (alert?: { component: React.ReactNode; show: boolean }) => React.ReactNode;
  renderPromptInput: () => React.ReactNode;
  renderDebugPanel: () => React.ReactNode;
}

function GraphEvidencePanel({ bundle }: { bundle: GraphEvidenceBundle }) {
  return (
    <div className='mt-2 ml-10 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm shadow-sm'>
      <div className='flex items-center justify-between gap-2'>
        <span className='font-semibold text-slate-900'>Graph Evidence</span>
        {bundle.insufficientEvidence ? (
          <span className='rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 text-xs'>Partial</span>
        ) : (
          <span className='rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800 text-xs'>Grounded</span>
        )}
      </div>

      <div className='mt-2 text-slate-700'>
        <span className='font-medium'>Confidence:</span>{' '}
        {bundle.confidenceLabel} ({Math.round(bundle.confidence * 100)}%)
      </div>

      {bundle.resolvedEntities.length > 0 && (
        <div className='mt-2 text-slate-700'>
          <span className='font-medium'>Resolved:</span>{' '}
          {bundle.resolvedEntities.map((entity) => `${entity.displayName} (${entity.typeName})`).join(', ')}
        </div>
      )}

      {bundle.plan.length > 0 && (
        <div className='mt-2 text-slate-700'>
          <span className='font-medium'>Plan:</span> {bundle.plan.map((step) => step.description).join(' | ')}
        </div>
      )}

      {bundle.items.length > 0 && (
        <div className='mt-3 space-y-2'>
          {bundle.items.slice(0, 6).map((item) => (
            <div key={item.id} className='rounded-md border border-slate-200 bg-white p-2'>
              <div className='font-medium text-slate-900'>{item.title}</div>
              <div className='text-slate-600'>{item.summary}</div>
            </div>
          ))}
        </div>
      )}

      {bundle.warnings.length > 0 && (
        <div className='mt-3 rounded-md bg-amber-50 p-2 text-amber-900 text-xs'>
          {bundle.warnings.join(' ')}
        </div>
      )}

      <div className='mt-3 rounded-md bg-slate-100 p-2 text-slate-700 text-xs'>
        {bundle.assessment.rationale}
      </div>
    </div>
  );
}

function GraphActionsPanel({ actions }: { actions: GraphAction[] }) {
  if (actions.length === 0) {
    return null;
  }

  return (
    <div className='mt-2 ml-10 rounded-lg border border-slate-200 bg-white p-3 text-slate-700 text-sm shadow-sm'>
      <div className='font-semibold text-slate-900'>Graph Actions</div>
      <div className='mt-2 flex flex-wrap gap-2'>
        {actions.map((action) => (
          <span key={action.id} className='rounded-full bg-sky-100 px-2 py-0.5 text-sky-800 text-xs'>
            {action.type}
          </span>
        ))}
      </div>
    </div>
  );
}

function DebugSection({
  title,
  value,
  tone = 'slate',
}: {
  title: string;
  value: React.ReactNode;
  tone?: 'slate' | 'amber' | 'emerald';
}) {
  const toneClass =
    tone === 'amber'
      ? 'border-amber-200 bg-amber-50'
      : tone === 'emerald'
        ? 'border-emerald-200 bg-emerald-50'
        : 'border-slate-200 bg-slate-50';

  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <div className='mb-1 font-medium text-slate-900 text-xs uppercase tracking-wide'>{title}</div>
      <div className='text-slate-700 text-sm'>{value}</div>
    </div>
  );
}

function DebugCode({ value }: { value: unknown }) {
  return (
    <pre className='max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-950 p-2 text-[11px] text-slate-100'>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function GraphAgentDebugPanel(props: {
  liveContext: {
    selectedNodeContext: GraphSelectionNodeContext[];
    selectedEdgeContext: GraphSelectionEdgeContext[];
    networkContext?: GraphNetworkContext;
  };
  lastPayload: GraphAgentDebugPayload | null;
  latestEvidence: GraphEvidenceBundle | null;
  latestGraphState: GraphStatePart['data'] | null;
  status: ReturnType<typeof useChat<GraphAgentUIMessage>>['status'];
}) {
  const { liveContext, lastPayload, latestEvidence, latestGraphState, status } = props;
  const liveSummary = {
    selectedNodes: liveContext.selectedNodeContext.length,
    selectedEdges: liveContext.selectedEdgeContext.length,
    totalNodes: liveContext.networkContext?.totalNodes ?? 0,
    totalEdges: liveContext.networkContext?.totalEdges ?? 0,
  };
  const latestWarnings = latestEvidence?.warnings ?? [];
  const backendState = latestGraphState?.state;

  return (
    <aside className='flex h-full w-[360px] shrink-0 flex-col border-l bg-white'>
      <div className='flex items-center gap-2 border-b px-4 py-3'>
        <BugIcon className='size-4 text-slate-500' />
        <div>
          <div className='font-semibold text-sm text-slate-900'>Graph Agent Debug</div>
          <div className='text-slate-500 text-xs'>Live client context and latest backend state</div>
        </div>
      </div>
      <div className='flex-1 space-y-3 overflow-y-auto p-3'>
        <DebugSection
          title='Live Context'
          tone={liveSummary.selectedNodes > 0 ? 'emerald' : 'amber'}
          value={
            <div className='space-y-1'>
              <div>Selected nodes: {liveSummary.selectedNodes}</div>
              <div>Selected edges: {liveSummary.selectedEdges}</div>
              <div>Visible network: {liveSummary.totalNodes} nodes / {liveSummary.totalEdges} edges</div>
            </div>
          }
        />
        <DebugSection
          title='Selected Nodes'
          value={
            liveContext.selectedNodeContext.length > 0 ? (
              <DebugCode value={liveContext.selectedNodeContext} />
            ) : (
              <span className='text-slate-500'>No nodes currently selected.</span>
            )
          }
        />
        <DebugSection
          title='Selected Edges'
          value={
            liveContext.selectedEdgeContext.length > 0 ? (
              <DebugCode value={liveContext.selectedEdgeContext} />
            ) : (
              <span className='text-slate-500'>No selected-edge context derived from the current selection.</span>
            )
          }
        />
        <DebugSection
          title='Network Context'
          value={
            liveContext.networkContext ? (
              <DebugCode value={liveContext.networkContext} />
            ) : (
              <span className='text-slate-500'>Sigma graph is not available yet.</span>
            )
          }
        />
        <DebugSection
          title='Last Sent Payload'
          tone={lastPayload ? 'emerald' : 'amber'}
          value={
            lastPayload ? (
              <DebugCode value={lastPayload} />
            ) : (
              <span className='text-slate-500'>No request has been sent in this session yet.</span>
            )
          }
        />
        <DebugSection
          title='Latest Evidence'
          tone={latestEvidence?.insufficientEvidence ? 'amber' : latestEvidence ? 'emerald' : 'slate'}
          value={
            latestEvidence ? (
              <div className='space-y-2'>
                <div>Status: {latestEvidence.insufficientEvidence ? 'Partial / insufficient' : 'Grounded'}</div>
                <div>
                  Confidence: {latestEvidence.confidenceLabel} ({Math.round(latestEvidence.confidence * 100)}%)
                </div>
                <div>Resolved entities: {latestEvidence.resolvedEntities.length}</div>
                <div>Evidence items: {latestEvidence.items.length}</div>
                <div>Plan steps: {latestEvidence.plan.length}</div>
                <div>Replan attempts: {latestEvidence.assessment.replanAttempts}</div>
                {latestWarnings.length > 0 && <DebugCode value={latestWarnings} />}
              </div>
            ) : (
              <span className='text-slate-500'>No graph evidence received yet.</span>
            )
          }
        />
        <DebugSection
          title='Latest Backend State'
          value={
            latestGraphState ? (
              <div className='space-y-2'>
                <div>Session: {latestGraphState.sessionId}</div>
                <div>Updated: {new Date(latestGraphState.state.updatedAt).toLocaleTimeString()}</div>
                <DebugCode
                  value={{
                    activeEntities: backendState?.activeEntities ?? [],
                    selectedNodeIds: backendState?.selectedNodeIds ?? [],
                    selectedEdgeIds: backendState?.selectedEdgeIds ?? [],
                    visibleNodeIds: backendState?.visibleNodeIds?.slice(0, 24) ?? [],
                    visibleEdgeIds: backendState?.visibleEdgeIds?.slice(0, 24) ?? [],
                    lastPlan: backendState?.lastPlan ?? [],
                  }}
                />
              </div>
            ) : (
              <span className='text-slate-500'>No backend graph state received yet.</span>
            )
          }
        />
        <DebugSection title='Chat Status' value={<div>{status}</div>} />
      </div>
    </aside>
  );
}

function buildGraphAgentContext(
  selectedNodes: string[],
  sigmaInstance: ReturnType<typeof useKGStore.getState>['sigmaInstance'],
) {
  const graph = sigmaInstance?.getGraph();
  const selectedNodeContext: GraphSelectionNodeContext[] = selectedNodes.map((nodeId) => {
    const label = graph?.getNodeAttribute(nodeId, 'label') || nodeId;
    const nodeType =
      String(graph?.getNodeAttribute(nodeId, 'nodeType') ?? graph?.getNodeAttribute(nodeId, 'typeCode') ?? '') ||
      undefined;
    return { id: nodeId, label, nodeType };
  });
  const selectedNodeSet = new Set(selectedNodes);
  const selectedEdgeContext: GraphSelectionEdgeContext[] = [];

  if (graph && selectedNodeSet.size > 1) {
    graph.forEachEdge((edgeId, attributes, source, target) => {
      if (!selectedNodeSet.has(source) || !selectedNodeSet.has(target) || selectedEdgeContext.length >= 64) {
        return;
      }

      selectedEdgeContext.push({
        id: edgeId,
        source,
        target,
        relation:
          typeof attributes.relation === 'string'
            ? attributes.relation
            : typeof attributes.label === 'string'
              ? attributes.label
              : undefined,
      });
    });
  }

  const networkContext: GraphNetworkContext | undefined = graph
    ? {
        totalNodes: graph.order,
        totalEdges: graph.size,
        selectedNodeIds: selectedNodes,
        visibleNodeIds: graph.nodes().slice(0, 160),
        visibleEdgeIds: graph.edges().slice(0, 320),
        topNodeTypes: (() => {
          const counts = new Map<string, number>();
          graph.forEachNode((nodeId) => {
            const nodeType = String(
              graph.getNodeAttribute(nodeId, 'nodeType') ?? graph.getNodeAttribute(nodeId, 'typeCode') ?? 'Entity',
            );
            counts.set(nodeType, (counts.get(nodeType) ?? 0) + 1);
          });

          return [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 6)
            .map(([type, count]) => ({ type, count }));
        })(),
      }
    : undefined;

  return {
    selectedNodeContext,
    selectedEdgeContext,
    networkContext,
  };
}

export function KGChat({ onChatOpen, children }: KGChatProps) {
  const [model, setModel] = React.useState<(typeof LLM_MODELS)[number]['id']>(LLM_MODELS[0].id);
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);
  const [checkpoints, setCheckpoints] = React.useState<CheckpointType[]>([]);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const processedActionIds = React.useRef<Set<string>>(new Set());
  const sigmaInstance = useKGStore((state) => state.sigmaInstance);
  const selectedNodes = useKGStore((state) => state.selectedNodes);
  const [lastDebugPayload, setLastDebugPayload] = React.useState<GraphAgentDebugPayload | null>(null);

  const sessionId = React.useMemo(() => generateSessionId(), []);
  const liveContext = React.useMemo(
    () => buildGraphAgentContext(selectedNodes, sigmaInstance),
    [selectedNodes, sigmaInstance],
  );

  const { messages, setMessages, sendMessage, status, regenerate, stop, clearError } = useChat<GraphAgentUIMessage>({
    transport: new DefaultChatTransport({
      api: `${graphAgentApiBaseUrl()}/graph-agent/chat`,
      prepareSendMessagesRequest({ body, messages }) {
        return {
          body: {
            ...body,
            messages: buildMinimalGraphAgentMessages(messages),
          },
        };
      },
    }),
    onError(error) {
      toast.error('Failed to fetch response from graph agent', {
        cancel: { label: 'Close', onClick() {} },
        description: error.message || 'Graph agent server is not responding. Please try again later.',
      });
    },
  });
  const latestEvidence = React.useMemo(() => {
    for (const message of [...messages].reverse()) {
      for (const part of [...message.parts].reverse()) {
        if (isGraphEvidencePart(part)) {
          return part.data;
        }
      }
    }
    return null;
  }, [messages]);
  const latestGraphState = React.useMemo(() => {
    for (const message of [...messages].reverse()) {
      for (const part of [...message.parts].reverse()) {
        if (isGraphStatePart(part)) {
          return part.data;
        }
      }
    }
    return null;
  }, [messages]);

  React.useEffect(() => {
    if (!sigmaInstance) {
      return;
    }

    const applyActions = async () => {
      for (const message of messages) {
        if (message.role !== 'assistant') {
          continue;
        }

        for (const part of message.parts) {
          if (!isGraphActionsPart(part)) {
            continue;
          }

          const actionBatchId = part.id ?? `${message.id}-graphActions`;
          if (processedActionIds.current.has(actionBatchId)) {
            continue;
          }

          processedActionIds.current.add(actionBatchId);

          for (const action of part.data) {
            if (action.type === 'load-subgraph') {
              await applyOptimusGraph(
                sigmaInstance,
                action.graph,
                action.mode,
                action.highlightNodeIds ?? [],
              );
            } else if (action.type === 'highlight-path') {
              highlightOptimusPath(sigmaInstance, action.nodeIds, action.edgeIds);
            } else if (action.type === 'focus-nodes') {
              focusOptimusNodes(sigmaInstance, action.nodeIds);
            }
          }
        }
      }
    };

    void applyActions();
  }, [messages, sigmaInstance]);

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

  const handleSubmit = async (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);

    if (!(hasText || hasAttachments)) {
      return;
    }

    onChatOpen?.(true);
    const { selectedNodeContext, selectedEdgeContext, networkContext } = liveContext;
    setLastDebugPayload({
      query: message.text,
      model,
      sessionId,
      selectedNodeContext,
      selectedEdgeContext,
      networkContext,
      createdAt: new Date().toISOString(),
    });

    sendMessage(
      { text: message.text, files: message.files },
      {
        body: {
          model,
          sessionId,
          userId: getUserId(),
          selectedNodeContext,
          selectedEdgeContext,
          networkContext,
        },
      },
    );
  };

  const handleDeleteMessages = () => {
    setMessages([]);
    setCheckpoints([]);
    processedActionIds.current.clear();
    onChatOpen?.(false);
  };

  const handleSubmitAction = () => {
    if (status === 'submitted' || status === 'streaming') {
      stop();
    } else if (status === 'error') {
      setMessages(messages.slice(0, -1));
      clearError();
    }
  };

  const renderMessages = (alert?: { component: React.ReactNode; show: boolean }) => (
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
                      .map((part, i) => (
                        <MessageAttachment key={`${message.id}-attachment-${i}`} data={part} />
                      ))}
                  </MessageAttachments>
                )}

                {message.parts.map((part, i) => {
                  switch (part.type) {
                    case 'text':
                      return (
                        <React.Fragment key={`${message.id}-${i}`}>
                          <Message from={message.role}>
                            <MessageContent className='shadow-md'>
                              <MessageResponse isAnimating={status === 'submitted' && message.role === 'assistant'}>
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
                        </React.Fragment>
                      );
                    case 'reasoning':
                      return (
                        <Reasoning
                          key={`${message.id}-${i}`}
                          className='w-full'
                          isStreaming={
                            status === 'streaming' &&
                            i === message.parts.length - 1 &&
                            message.id === messages.at(-1)?.id
                          }
                        >
                          <ReasoningTrigger />
                          <ReasoningContent className='rounded-md border p-2 text-black'>{part.text}</ReasoningContent>
                        </Reasoning>
                      );
                    case 'file':
                      return null;
                    case 'data-graphEvidence':
                      if (!isGraphEvidencePart(part)) {
                        return null;
                      }
                      return <GraphEvidencePanel key={`${message.id}-${i}`} bundle={part.data} />;
                    case 'data-graphActions':
                      if (!isGraphActionsPart(part)) {
                        return null;
                      }
                      return <GraphActionsPanel key={`${message.id}-${i}`} actions={part.data} />;
                    case 'data-graphState':
                      if (!isGraphStatePart(part)) {
                        return null;
                      }
                      return (
                        <div key={`${message.id}-${i}`} className='mt-2 ml-10 text-slate-500 text-xs'>
                          Session: {part.data.sessionId} • Updated {new Date(part.data.state.updatedAt).toLocaleTimeString()}
                        </div>
                      );
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
        {alert?.show && alert.component}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );

  const renderPromptInput = () => {
    const selectedModelData = LLM_MODELS.find((entry) => entry.id === model);

    return (
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
  };

  const renderDebugPanel = () => {
    if (!GRAPH_AGENT_DEBUG_ENABLED) {
      return null;
    }

    return (
      <GraphAgentDebugPanel
        liveContext={liveContext}
        lastPayload={lastDebugPayload}
        latestEvidence={latestEvidence}
        latestGraphState={latestGraphState}
        status={status}
      />
    );
  };

  if (children) {
    return (
      <>
        {children({
          model,
          messages,
          status,
          checkpoints,
          handleSubmit,
          handleDeleteMessages,
          handleSubmitAction,
          setModel,
          regenerate,
          createCheckpoint,
          restoreToCheckpoint,
          renderMessages,
          renderPromptInput,
          renderDebugPanel,
        })}
      </>
    );
  }

  return null;
}
