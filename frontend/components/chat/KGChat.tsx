'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { BookmarkIcon, BugIcon, CheckIcon, ChevronDownIcon, LightbulbIcon, Loader2Icon, RefreshCcwIcon } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import React from 'react';
import { toast } from 'sonner';
import { LLM_MODELS } from '@/lib/data';
import {
  clearGraphAgentHandoffSnapshot,
  loadGraphAgentHandoffSnapshot,
  saveGraphAgentHandoffSnapshot,
  type GraphAgentHandoffSnapshot,
} from '@/lib/graph-agent-handoff';
import type {
  GraphAction,
  GraphDebugStep,
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
  clearPreviewOptimusNode,
  focusOptimusNodes,
  highlightOptimusPath,
  previewOptimusNode,
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
  usePromptInputController,
} from '../ai-elements/prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '../ai-elements/reasoning';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';

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
type GraphDebugPart = { type: 'data-graphDebug'; id?: string; data: GraphDebugStep[] };

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

function isGraphDebugPart(part: GraphAgentPart): part is GraphDebugPart {
  return part.type === 'data-graphDebug';
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
  const confidence = Number.isFinite(bundle.confidence) ? bundle.confidence : 0;
  const confidenceLabel = bundle.confidenceLabel ?? 'low';
  const assessmentRationale =
    bundle.assessment?.rationale ??
    (bundle.warnings.length > 0
      ? bundle.warnings.join(' ')
      : bundle.insufficientEvidence
        ? 'Evidence is partial or insufficient for a fully grounded answer.'
        : 'Evidence was grounded from retrieved graph results.');

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
        {confidenceLabel} ({Math.round(confidence * 100)}%)
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
              <div className='whitespace-pre-wrap text-slate-600'>{item.summary}</div>
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
        {assessmentRationale}
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

type GraphEntityCandidate = {
  id: string;
  label: string;
  nodeType?: string;
};

function PromptInputValueSync({
  value,
}: {
  value: string;
}) {
  const controller = usePromptInputController();

  React.useEffect(() => {
    if (controller.textInput.value !== value) {
      controller.textInput.setInput(value);
    }
  }, [controller, value]);

  return null;
}

function collectGraphCandidates(
  message: GraphAgentUIMessage,
  sigmaInstance: ReturnType<typeof useKGStore.getState>['sigmaInstance'],
) {
  const graph = sigmaInstance?.getGraph();
  const evidencePart = message.parts.find((part): part is GraphEvidencePart => isGraphEvidencePart(part));
  const candidates = new Map<string, GraphEntityCandidate>();

  for (const entity of evidencePart?.data.resolvedEntities ?? []) {
    candidates.set(entity.id, {
      id: entity.id,
      label: entity.displayName,
      nodeType: entity.typeName,
    });
  }

  if (graph && evidencePart) {
    for (const item of evidencePart.data.items) {
      for (const nodeId of item.nodeIds) {
        if (!graph.hasNode(nodeId)) {
          continue;
        }
        candidates.set(nodeId, {
          id: nodeId,
          label: String(graph.getNodeAttribute(nodeId, 'label') ?? nodeId),
          nodeType:
            String(graph.getNodeAttribute(nodeId, 'nodeType') ?? graph.getNodeAttribute(nodeId, 'typeCode') ?? '') ||
            undefined,
        });
      }
    }
  }

  if (graph) {
    for (const nodeId of graph.nodes()) {
      if (graph.getNodeAttribute(nodeId, 'hidden') === true) {
        continue;
      }

      const label = String(graph.getNodeAttribute(nodeId, 'label') ?? nodeId).trim();
      if (label.length < 3) {
        continue;
      }

      candidates.set(nodeId, {
        id: nodeId,
        label,
        nodeType:
          String(graph.getNodeAttribute(nodeId, 'nodeType') ?? graph.getNodeAttribute(nodeId, 'typeCode') ?? '') ||
          undefined,
      });
    }
  }

  return [...candidates.values()]
    .filter((candidate) => candidate.label.trim().length >= 3)
    .sort((a, b) => b.label.length - a.label.length || a.label.localeCompare(b.label))
    .slice(0, 600);
}

function tokenizeGraphAwareText(text: string, candidates: GraphEntityCandidate[]) {
  const parts: Array<{ type: 'text'; value: string } | { type: 'entity'; candidate: GraphEntityCandidate }> = [];
  let cursor = 0;
  const lowerText = text.toLowerCase();

  while (cursor < text.length) {
    let bestMatch:
      | {
          start: number;
          end: number;
          candidate: GraphEntityCandidate;
        }
      | undefined;

    for (const candidate of candidates) {
      const index = lowerText.indexOf(candidate.label.toLowerCase(), cursor);
      if (index === -1) {
        continue;
      }

      if (
        !bestMatch ||
        index < bestMatch.start ||
        (index === bestMatch.start && candidate.label.length > bestMatch.candidate.label.length)
      ) {
        bestMatch = {
          start: index,
          end: index + candidate.label.length,
          candidate,
        };
      }
    }

    if (!bestMatch) {
      parts.push({ type: 'text', value: text.slice(cursor) });
      break;
    }

    if (bestMatch.start > cursor) {
      parts.push({ type: 'text', value: text.slice(cursor, bestMatch.start) });
    }

    parts.push({ type: 'entity', candidate: bestMatch.candidate });
    cursor = bestMatch.end;
  }

  return parts;
}

function GraphAwareText({
  text,
  message,
  sigmaInstance,
}: {
  text: string;
  message: GraphAgentUIMessage;
  sigmaInstance: ReturnType<typeof useKGStore.getState>['sigmaInstance'];
}) {
  const candidates = React.useMemo(() => collectGraphCandidates(message, sigmaInstance), [message, sigmaInstance]);
  const tokenized = React.useMemo(() => tokenizeGraphAwareText(text, candidates), [text, candidates]);

  if (candidates.length === 0) {
    return <MessageResponse isAnimating={false}>{text}</MessageResponse>;
  }

  return (
    <div className='whitespace-pre-wrap'>
      {tokenized.map((part, index) =>
        part.type === 'text' ? (
          <React.Fragment key={`text-${index}`}>{part.value}</React.Fragment>
        ) : (
          <button
            key={`entity-${part.candidate.id}-${index}`}
            type='button'
            className='inline rounded bg-sky-100 px-1 py-0.5 font-medium text-sky-900 underline-offset-2 hover:bg-sky-200 hover:underline'
            onMouseEnter={() => {
              if (!sigmaInstance) return;
              previewOptimusNode(sigmaInstance, part.candidate.id);
            }}
            onMouseLeave={() => {
              if (!sigmaInstance) return;
              clearPreviewOptimusNode(sigmaInstance, part.candidate.id);
            }}
            onClick={() => {
              if (!sigmaInstance) return;
              useKGStore.getState().setGraphSelection({ nodeIds: [part.candidate.id], edgeIds: [] });
              useKGStore.getState().setInspectedNodeId(part.candidate.id);
            }}
          >
            {part.candidate.label}
          </button>
        ),
      )}
    </div>
  );
}

function buildFollowUpSuggestions(params: {
  message: GraphAgentUIMessage;
  previousQueries: string[];
  liveContext: {
    selectedNodeContext: GraphSelectionNodeContext[];
    selectedEdgeContext: GraphSelectionEdgeContext[];
    networkContext?: GraphNetworkContext;
  };
}) {
  const evidencePart = params.message.parts.find((part): part is GraphEvidencePart => isGraphEvidencePart(part));
  if (!evidencePart) {
    return [];
  }

  const { bundle } = { bundle: evidencePart.data };
  const contextLabels = [
    ...params.liveContext.selectedNodeContext.map((node) => node.label),
    ...(params.liveContext.networkContext?.visibleNodeContext ?? []).slice(0, 12).map((node) => node.label),
    ...bundle.resolvedEntities.map((entity) => entity.displayName),
  ].filter((label, index, all) => label.trim().length > 0 && all.findIndex((candidate) => candidate === label) === index);
  const primaryLabels = contextLabels.slice(0, 3);
  const joinedPrimaryLabels = primaryLabels.join(', ');
  const primaryEntityType =
    bundle.resolvedEntities[0]?.typeName ??
    params.liveContext.selectedNodeContext[0]?.nodeType ??
    params.liveContext.networkContext?.topNodeTypes?.[0]?.type ??
    'entity';
  const resolvedTypes = new Set(bundle.resolvedEntities.map((entity) => entity.typeName.toLowerCase()));
  const planOps = new Set(bundle.plan.map((step) => step.operation));
  const suggestions: string[] = [];

  if (primaryLabels.length > 0) {
    suggestions.push(
      primaryLabels.length > 1
        ? `How are ${joinedPrimaryLabels} connected within the current network?`
        : `What is the local network neighborhood around ${primaryLabels[0]}?`,
    );
  }
  if (params.liveContext.selectedNodeContext.length > 1) {
    suggestions.push(
      `What pathways connect ${joinedPrimaryLabels || 'these selected nodes'}?`,
    );
  }
  if ([...resolvedTypes].some((type) => /gene|protein/.test(type)) || /gene|protein/i.test(primaryEntityType)) {
    suggestions.push(
      primaryLabels.length > 0
        ? `Which diseases are linked to ${joinedPrimaryLabels}?`
        : 'What diseases are associated with these genes?',
    );
    suggestions.push(
      primaryLabels.length > 0
        ? `Which approved drugs target pathways connected to ${joinedPrimaryLabels}?`
        : 'Which approved drugs target these proteins?',
    );
  }
  if ([...resolvedTypes].some((type) => /disease|phenotype|syndrome|disorder/.test(type)) || /disease|phenotype|syndrome|disorder/i.test(primaryEntityType)) {
    suggestions.push(
      primaryLabels.length > 0
        ? `Which genes are most central around ${joinedPrimaryLabels}?`
        : 'Which genes are most central to this disease module?',
    );
    suggestions.push(
      primaryLabels.length > 0
        ? `What pathways connect the entities surrounding ${joinedPrimaryLabels}?`
        : 'What pathways connect these disease-linked entities?',
    );
  }
  if (planOps.has('summarize-selected-nodes') || planOps.has('summarize-visible-subgraph')) {
    suggestions.push('Which nodes are the main hubs in this graph?');
    suggestions.push(
      primaryLabels.length > 0
        ? `Which adjacent nodes around ${joinedPrimaryLabels} would be most informative to expand next?`
        : 'Which adjacent regions of this network are most informative to expand next?',
    );
  }
  if (planOps.has('compare-nodes') || planOps.has('find-shared-pathways')) {
    suggestions.push(
      primaryLabels.length > 0
        ? `Which shared pathways or diseases best explain the overlap between ${joinedPrimaryLabels}?`
        : 'Which diseases share these biomarkers?',
    );
  }
  if (planOps.has('build-gene-network') || planOps.has('build-multi-entity-network') || planOps.has('expand-subgraph')) {
    suggestions.push(
      primaryLabels.length > 0
        ? `Which nearby pathways, drugs, or phenotypes should I add next around ${joinedPrimaryLabels}?`
        : 'Which nearby pathways, drugs, or phenotypes should I add next in this graph?',
    );
  }
  if (bundle.query.trim().length > 0) {
    suggestions.push(`What is the strongest biological interpretation of the network built for "${bundle.query}"?`);
  }

  return suggestions.filter((suggestion, index, all) => {
    const normalized = suggestion.trim().toLowerCase();
    return (
      normalized.length > 0 &&
      all.findIndex((candidate) => candidate.trim().toLowerCase() === normalized) === index &&
      !params.previousQueries.some((query) => query.trim().toLowerCase() === normalized)
    );
  }).slice(0, 3);
}

function ReasoningEvidenceDisclosure(props: {
  message: GraphAgentUIMessage;
  evidence: GraphEvidenceBundle | null;
  actions: GraphAction[];
  reasoningParts: string[];
}) {
  const { evidence, actions, reasoningParts } = props;
  if (!evidence && actions.length === 0 && reasoningParts.length === 0) {
    return null;
  }

  return (
    <Collapsible className='mt-2 ml-10 rounded-lg border border-slate-200 bg-white shadow-sm'>
      <CollapsibleTrigger className='flex w-full items-center justify-between px-3 py-2 text-left text-slate-700 text-sm'>
        <span className='font-medium'>Show Reasoning &amp; Evidence</span>
        <ChevronDownIcon className='size-4' />
      </CollapsibleTrigger>
      <CollapsibleContent className='border-t bg-slate-50 px-2 py-2'>
        {reasoningParts.length > 0 && (
          <div className='mb-2 rounded-md border border-slate-200 bg-white p-2'>
            <div className='mb-1 font-semibold text-slate-900 text-sm'>Reasoning</div>
            {reasoningParts.map((reasoning, index) => (
              <Reasoning key={`reasoning-${index}`} className='w-full'>
                <ReasoningTrigger />
                <ReasoningContent className='rounded-md border p-2 text-black'>{reasoning}</ReasoningContent>
              </Reasoning>
            ))}
          </div>
        )}
        {evidence && <GraphEvidencePanel bundle={evidence} />}
        {actions.length > 0 && <GraphActionsPanel actions={actions} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

function FollowUpSuggestions(props: {
  suggestions: string[];
  onPick: (suggestion: string) => void;
}) {
  if (props.suggestions.length === 0) {
    return null;
  }

  return (
    <div className='mt-2 ml-10 rounded-lg border border-slate-200 bg-white p-3 shadow-sm'>
      <div className='mb-2 flex items-center gap-2 font-semibold text-slate-900 text-sm'>
        <LightbulbIcon className='size-4 text-amber-500' />
        Suggested Follow-Up Questions
      </div>
      <div className='flex flex-wrap gap-2'>
        {props.suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type='button'
            className='rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-sky-900 text-sm hover:bg-sky-100'
            onClick={() => props.onPick(suggestion)}
          >
            {suggestion}
          </button>
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

function graphDebugStatusClass(status: GraphDebugStep['status']) {
  if (status === 'success') {
    return 'border-emerald-200 bg-emerald-50';
  }
  if (status === 'warning') {
    return 'border-amber-200 bg-amber-50';
  }
  return 'border-slate-200 bg-slate-50';
}

function GraphDebugStepCard({ step }: { step: GraphDebugStep }) {
  return (
    <div className={`rounded-md border p-3 ${graphDebugStatusClass(step.status)}`}>
      <div className='flex items-start justify-between gap-2'>
        <div>
          <div className='font-medium text-slate-900 text-sm'>{step.title}</div>
          <div className='text-slate-500 text-[11px] uppercase tracking-wide'>{step.stage}</div>
        </div>
        <div className='text-slate-500 text-xs'>{new Date(step.createdAt).toLocaleTimeString()}</div>
      </div>
      <div className='mt-2 text-slate-700 text-sm'>{step.summary}</div>
      {step.llm?.used && step.llm.deductions.length > 0 && (
        <div className='mt-2 rounded-md border border-sky-200 bg-sky-50 p-2'>
          <div className='mb-1 flex items-center gap-1 font-medium text-sky-900 text-xs uppercase tracking-wide'>
            <LightbulbIcon className='size-3' />
            LLM Deductions ({step.llm.mode})
          </div>
          <ul className='space-y-1 text-sky-950 text-xs'>
            {step.llm.deductions.slice(0, 6).map((deduction, index) => (
              <li key={`${step.id}-deduction-${index}`}>{deduction}</li>
            ))}
          </ul>
        </div>
      )}
      {step.details && (
        <details className='mt-2'>
          <summary className='cursor-pointer text-slate-600 text-xs'>Details</summary>
          <div className='mt-2'>
            <DebugCode value={step.details} />
          </div>
        </details>
      )}
    </div>
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
  latestDebugSteps: GraphDebugStep[];
  latestGraphState: GraphStatePart['data'] | null;
  status: ReturnType<typeof useChat<GraphAgentUIMessage>>['status'];
}) {
  const { liveContext, lastPayload, latestEvidence, latestDebugSteps, latestGraphState, status } = props;
  const liveSummary = {
    selectedNodes: liveContext.selectedNodeContext.length,
    selectedEdges: liveContext.selectedEdgeContext.length,
    totalNodes: liveContext.networkContext?.totalNodes ?? 0,
    totalEdges: liveContext.networkContext?.totalEdges ?? 0,
  };
  const latestWarnings = latestEvidence?.warnings ?? [];
  const backendState = latestGraphState?.state;
  const llmDeductions = latestDebugSteps.flatMap((step) =>
    step.llm?.used
      ? step.llm.deductions.map((deduction) => ({
          id: `${step.id}-${deduction}`,
          stage: step.title,
          deduction,
        }))
      : [],
  );

  return (
    <aside className='flex h-full w-[360px] shrink-0 flex-col border-l bg-white'>
      <div className='flex items-center gap-2 border-b px-4 py-3'>
        <BugIcon className='size-4 text-slate-500' />
        <div>
          <div className='font-semibold text-sm text-slate-900'>Graph Agent Debug</div>
          <div className='text-slate-500 text-xs'>Live context, streamed execution steps, and LLM deductions</div>
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
          title='Processing Steps'
          tone={latestDebugSteps.some((step) => step.status === 'warning') ? 'amber' : latestDebugSteps.length > 0 ? 'emerald' : 'slate'}
          value={
            latestDebugSteps.length > 0 ? (
              <div className='space-y-2'>
                {latestDebugSteps.map((step) => (
                  <GraphDebugStepCard key={step.id} step={step} />
                ))}
              </div>
            ) : (
              <span className='text-slate-500'>No streamed backend debug steps received yet.</span>
            )
          }
        />
        <DebugSection
          title='LLM Deductions'
          tone={llmDeductions.length > 0 ? 'emerald' : 'slate'}
          value={
            llmDeductions.length > 0 ? (
              <div className='space-y-2'>
                {llmDeductions.map((item) => (
                  <div key={item.id} className='rounded-md border border-sky-200 bg-sky-50 p-2'>
                    <div className='font-medium text-sky-900 text-xs uppercase tracking-wide'>{item.stage}</div>
                    <div className='mt-1 text-sky-950 text-sm'>{item.deduction}</div>
                  </div>
                ))}
              </div>
            ) : (
              <span className='text-slate-500'>No LLM-assisted deductions were emitted for the latest response.</span>
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
                  Confidence: {latestEvidence.confidenceLabel ?? 'low'} ({Math.round((latestEvidence.confidence ?? 0) * 100)}%)
                </div>
                <div>Resolved entities: {latestEvidence.resolvedEntities.length}</div>
                <div>Evidence items: {latestEvidence.items.length}</div>
                <div>Plan steps: {latestEvidence.plan.length}</div>
                <div>Replan attempts: {latestEvidence.assessment?.replanAttempts ?? 0}</div>
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
  selectedEdges: string[],
  sigmaInstance: ReturnType<typeof useKGStore.getState>['sigmaInstance'],
) {
  const graph = sigmaInstance?.getGraph();
  const visibleNodeIds = graph ? graph.filterNodes((nodeId) => graph.getNodeAttribute(nodeId, 'hidden') !== true) : [];
  const visibleNodeIdSet = new Set(visibleNodeIds);
  const visibleEdgeIds = graph
    ? graph.filterEdges((edgeId) => {
        if (graph.getEdgeAttribute(edgeId, 'hidden') === true) {
          return false;
        }

        const source = graph.source(edgeId);
        const target = graph.target(edgeId);
        return visibleNodeIdSet.has(source) && visibleNodeIdSet.has(target);
      })
    : [];
  const validSelectedEdgeIds = (graph ? selectedEdges : []).filter((edgeId) => graph?.hasEdge(edgeId));
  const selectedNodeIdSet = new Set((graph ? selectedNodes.filter((nodeId) => graph.hasNode(nodeId)) : []) as string[]);
  validSelectedEdgeIds.forEach((edgeId) => {
    const source = graph?.source(edgeId);
    const target = graph?.target(edgeId);
    if (source && graph?.hasNode(source)) {
      selectedNodeIdSet.add(source);
    }
    if (target && graph?.hasNode(target)) {
      selectedNodeIdSet.add(target);
    }
  });
  const validSelectedNodeIds = [...selectedNodeIdSet];

  const selectedNodeContext: GraphSelectionNodeContext[] = validSelectedNodeIds.map((nodeId) => {
    const label = graph?.hasNode(nodeId) ? String(graph.getNodeAttribute(nodeId, 'label') ?? nodeId) : nodeId;
    const nodeType =
      String(
        graph?.hasNode(nodeId)
          ? graph.getNodeAttribute(nodeId, 'nodeType') ?? graph.getNodeAttribute(nodeId, 'typeCode') ?? ''
          : '',
      ) ||
      undefined;
    return { id: nodeId, label, nodeType };
  });
  const selectedEdgeContext: GraphSelectionEdgeContext[] = validSelectedEdgeIds
    .slice(0, 128)
    .map((edgeId) => ({
      id: edgeId,
      source: graph!.source(edgeId),
      target: graph!.target(edgeId),
      relation:
        typeof graph!.getEdgeAttribute(edgeId, 'relation') === 'string'
          ? graph!.getEdgeAttribute(edgeId, 'relation')
          : typeof graph!.getEdgeAttribute(edgeId, 'label') === 'string'
            ? graph!.getEdgeAttribute(edgeId, 'label')
            : undefined,
    }));

  const networkContext: GraphNetworkContext | undefined = graph
    ? {
        totalNodes: visibleNodeIds.length,
        totalEdges: visibleEdgeIds.length,
        selectedNodeIds: validSelectedNodeIds,
        selectedEdgeIds: validSelectedEdgeIds,
        visibleNodeIds,
        visibleEdgeIds,
        visibleNodeContext: visibleNodeIds.map((nodeId) => ({
            id: nodeId,
            label: String(graph.getNodeAttribute(nodeId, 'label') ?? nodeId),
            nodeType:
              String(graph.getNodeAttribute(nodeId, 'nodeType') ?? graph.getNodeAttribute(nodeId, 'typeCode') ?? '') ||
              undefined,
          })),
        topNodeTypes: (() => {
          const counts = new Map<string, number>();
          visibleNodeIds.forEach((nodeId) => {
            const nodeType = String(
              graph.getNodeAttribute(nodeId, 'nodeType') ?? graph.getNodeAttribute(nodeId, 'typeCode') ?? 'Entity',
            );
            counts.set(nodeType, (counts.get(nodeType) ?? 0) + 1);
          });

          return [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 12)
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
  const router = useRouter();
  const pathname = usePathname();
  const [model, setModel] = React.useState<(typeof LLM_MODELS)[number]['id']>(LLM_MODELS[0].id);
  const [modelSelectorOpen, setModelSelectorOpen] = React.useState(false);
  const [checkpoints, setCheckpoints] = React.useState<CheckpointType[]>([]);
  const [draftText, setDraftText] = React.useState('');
  const [handoffState, setHandoffState] = React.useState<null | { message: string }>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const processedActionIds = React.useRef<Set<string>>(new Set());
  const handoffTriggered = React.useRef(false);
  const restoredHandoffSnapshot = React.useRef(false);
  const pendingHandoffSnapshot = React.useRef<GraphAgentHandoffSnapshot | null>(null);
  const sigmaInstance = useKGStore((state) => state.sigmaInstance);
  const setGraphSelection = useKGStore((state) => state.setGraphSelection);
  const selectedNodes = useKGStore((state) => state.selectedNodes);
  const selectedEdges = useKGStore((state) => state.selectedEdges);
  const [lastDebugPayload, setLastDebugPayload] = React.useState<GraphAgentDebugPayload | null>(null);

  const [sessionId, setSessionId] = React.useState(() => generateSessionId());
  const liveContext = React.useMemo(
    () => buildGraphAgentContext(selectedNodes, selectedEdges, sigmaInstance),
    [selectedNodes, selectedEdges, sigmaInstance],
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

  React.useEffect(() => {
    if (restoredHandoffSnapshot.current || pathname !== '/knowledge-graph') {
      return;
    }

    restoredHandoffSnapshot.current = true;
    const snapshot = loadGraphAgentHandoffSnapshot();
    if (!snapshot) {
      return;
    }

    pendingHandoffSnapshot.current = snapshot;
    processedActionIds.current.clear();
    setSessionId(snapshot.sessionId);
    if (LLM_MODELS.some((candidate) => candidate.id === snapshot.model)) {
      setModel(snapshot.model as (typeof LLM_MODELS)[number]['id']);
    }
    setMessages(snapshot.messages);
    onChatOpen?.(true);
  }, [onChatOpen, pathname, setMessages]);

  React.useEffect(() => {
    if (pathname !== '/knowledge-graph') {
      return;
    }

    const snapshot = pendingHandoffSnapshot.current;
    if (!snapshot) {
      return;
    }

    const hasHydratedMessages = messages.length >= snapshot.messages.length && snapshot.messages.length > 0;
    if (!hasHydratedMessages) {
      setMessages(snapshot.messages);
      return;
    }

    pendingHandoffSnapshot.current = null;
    clearGraphAgentHandoffSnapshot();
  }, [messages, pathname, setMessages]);
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
  const latestDebugSteps = React.useMemo(() => {
    const latestAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.parts.some((part) => isGraphDebugPart(part)));

    if (!latestAssistantMessage) {
      return [];
    }

    return latestAssistantMessage.parts.flatMap((part) => (isGraphDebugPart(part) ? part.data : []));
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

  const handleSuggestionPick = React.useCallback((suggestion: string) => {
    setDraftText(suggestion);
    onChatOpen?.(true);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(suggestion.length, suggestion.length);
    }, 0);
  }, [onChatOpen]);

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
                action.focusMode ?? 'highlighted',
              );
              if ((action.highlightNodeIds ?? []).length > 0) {
                setGraphSelection({
                  nodeIds: action.highlightNodeIds ?? [],
                  edgeIds: [],
                });
              }
            } else if (action.type === 'highlight-path') {
              highlightOptimusPath(sigmaInstance, action.nodeIds, action.edgeIds);
              setGraphSelection({
                nodeIds: action.nodeIds,
                edgeIds: action.edgeIds,
              });
            } else if (action.type === 'focus-nodes') {
              focusOptimusNodes(sigmaInstance, action.nodeIds);
              setGraphSelection({
                nodeIds: action.nodeIds,
                edgeIds: [],
              });
            }
          }
        }
      }
    };

    void applyActions();
  }, [messages, setGraphSelection, sigmaInstance]);

  React.useEffect(() => {
    if (pathname !== '/explore' || handoffTriggered.current) {
      return;
    }
    if (status === 'submitted' || status === 'streaming') {
      return;
    }

    const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    if (!latestAssistant) {
      return;
    }

    const actionsPart = [...latestAssistant.parts].reverse().find(isGraphActionsPart);
    const statePart = [...latestAssistant.parts].reverse().find(isGraphStatePart);
    if (!actionsPart || !statePart) {
      return;
    }

    const generatedGraphAction = actionsPart.data.find(
      (action) =>
        action.type === 'load-subgraph' &&
        (action.graph.nodes.length > 1 || action.graph.edges.length > 0),
    );
    if (!generatedGraphAction) {
      return;
    }

    handoffTriggered.current = true;
    saveGraphAgentHandoffSnapshot({
      createdAt: new Date().toISOString(),
      sourceRoute: '/explore',
      sessionId: statePart.data.sessionId || sessionId,
      model,
      messages,
    });
    setHandoffState({ message: 'Generating your graph...' });
    onChatOpen?.(true);

    const transitionTimeout = window.setTimeout(() => {
      router.push('/knowledge-graph');
    }, 180);

    return () => {
      window.clearTimeout(transitionTimeout);
    };
  }, [messages, model, onChatOpen, pathname, router, sessionId, status]);

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
    setDraftText('');
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
          const hasTextPart = message.parts.some((part) => part.type === 'text');
          const evidencePart = message.parts.find((part): part is GraphEvidencePart => isGraphEvidencePart(part)) ?? null;
          const actionsPart = message.parts.find((part): part is GraphActionsPart => isGraphActionsPart(part)) ?? null;
          const reasoningParts = message.parts
            .filter((part): part is Extract<GraphAgentPart, { type: 'reasoning' }> => part.type === 'reasoning')
            .map((part) => part.text);
          const previousQueries = messages
            .slice(0, messageIndex)
            .filter((candidate) => candidate.role === 'user')
            .flatMap((candidate) =>
              candidate.parts
                .filter((part): part is Extract<GraphAgentPart, { type: 'text' }> => part.type === 'text')
                .map((part) => part.text),
            );
          const suggestions =
            message.role === 'assistant'
              ? buildFollowUpSuggestions({
                  message,
                  previousQueries,
                  liveContext,
                })
              : [];
          const isAssistantDataOnlyMessage = message.role === 'assistant' && !hasTextPart && !hasAttachments;

          if (isAssistantDataOnlyMessage) {
            return null;
          }

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
                              {message.role === 'assistant' ? (
                                <GraphAwareText text={part.text} message={message} sigmaInstance={sigmaInstance} />
                              ) : (
                                <MessageResponse isAnimating={status === 'submitted'}>{part.text}</MessageResponse>
                              )}
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
                      return null;
                    case 'file':
                      return null;
                    case 'data-graphEvidence':
                      return null;
                    case 'data-graphActions':
                      return null;
                    case 'data-graphDebug':
                      return null;
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
                {message.role === 'assistant' && (
                  <>
                    <ReasoningEvidenceDisclosure
                      message={message}
                      evidence={evidencePart?.data ?? null}
                      actions={actionsPart?.data ?? []}
                      reasoningParts={reasoningParts}
                    />
                    <FollowUpSuggestions suggestions={suggestions} onPick={handleSuggestionPick} />
                  </>
                )}
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
        {(status === 'submitted' || status === 'streaming') &&
          (() => {
            const lastMessage = messages.at(-1);
            const lastAssistantHasText =
              lastMessage?.role === 'assistant' && lastMessage.parts.some((part) => part.type === 'text');

            if (lastAssistantHasText) {
              return null;
            }

            return (
              <Message from='assistant'>
                <MessageContent className='shadow-md'>
                  <div className='flex items-center gap-2 text-slate-600 text-sm'>
                    <Loader2Icon className='size-4 animate-spin' />
                    <span>Thinking over the graph context...</span>
                  </div>
                </MessageContent>
                <MessageAvatar className='p-1 shadow' src='/image/logo.svg' name='AI' />
              </Message>
            );
          })()}
        {alert?.show && alert.component}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );

  const renderPromptInput = () => {
    const selectedModelData = LLM_MODELS.find((entry) => entry.id === model);

    return (
      <PromptInputProvider>
        <PromptInputValueSync value={draftText} />
        <PromptInput globalDrop multiple onSubmit={handleSubmit} className='mx-2'>
          <PromptInputAttachments>{(attachment) => <PromptInputAttachment data={attachment} />}</PromptInputAttachments>
          <PromptInputBody>
            <PromptInputTextarea
              ref={textareaRef}
              disabled={status === 'error'}
              onChange={(event) => setDraftText(event.target.value)}
            />
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
        latestDebugSteps={latestDebugSteps}
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

  return null;
}
