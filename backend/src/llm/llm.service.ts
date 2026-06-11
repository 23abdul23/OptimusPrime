import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  convertToModelMessages,
  createProviderRegistry,
  ProviderRegistryProvider,
  streamText,
  UIMessage,
  tool,
  stepCountIs,
} from 'ai';
import { z } from 'zod';
import { PromptDto, DEFAULT_MODEL } from '@/llm/model.constants';
import { createOpenAICompatible, OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import { tavily } from '@tavily/core';
import {
  buildKnowledgeGraphChatSystemPrompt,
  GENERAL_BIOMEDICAL_CHAT_SYSTEM_PROMPT,
} from '@/llm/system-prompts';

@Injectable()
export class LlmService {
  private modelRegistry: ProviderRegistryProvider<{ openai: OpenAICompatibleProvider }, ':'>;

  private tavilyClient: ReturnType<typeof tavily> | null = null;

  constructor(private configService: ConfigService) {
    if (!this.configService.get<string>('OPENAI_API_KEY')) {
      throw new Error('OPENAI_API_KEY is not configured in environment variables');
    }

    // Initialize Tavily for web search (optional)
    const tavilyApiKey = this.configService.get<string>('TAVILY_API_KEY');
    if (tavilyApiKey) {
      this.tavilyClient = tavily({ apiKey: tavilyApiKey });
    }

    this.modelRegistry = createProviderRegistry({
      openai: createOpenAICompatible({
        name: 'openai',
        apiKey: this.configService.get<string>('OPENAI_API_KEY'),
        baseURL: 'https://api.openai.com/v1',
      }),
    });
  }

  generateResponseStream(promptDto: PromptDto) {
    const model = promptDto.model || DEFAULT_MODEL;

    // Note: Langfuse tracing handled by experimental_telemetry + controller's observe() wrapper
    return streamText({
      model: this.modelRegistry.languageModel(model),
      system: GENERAL_BIOMEDICAL_CHAT_SYSTEM_PROMPT,
      messages: convertToModelMessages((promptDto.messages as UIMessage[]) ?? []),
      temperature: 0,
      topP: 0.7,
      maxOutputTokens: 4096,
      // Enable Vercel AI SDK telemetry for automatic tracing
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'llm-generate-response',
      },
      // Note: Telemetry handled automatically by experimental_telemetry
    });
  }

  /**
   * Generate streaming response with tool calling support for Knowledge Graph analysis
   * Backend generates metadata via Tavily search, frontend provides graph data
   */
  generateKGChatStream(promptDto: PromptDto) {
    const modelId = (promptDto.model || DEFAULT_MODEL) as `openai:${string}`;

    // Generate tools (backend-side)
    const tools = this.generateKGTools();

    const systemPrompt = buildKnowledgeGraphChatSystemPrompt(promptDto.selectedNodeContext ?? []);

    // Note: Langfuse tracing handled by experimental_telemetry + controller's observe() wrapper
    return streamText({
      model: this.modelRegistry.languageModel(modelId),
      system: systemPrompt,
      messages: convertToModelMessages((promptDto.messages as UIMessage[]) ?? []),
      tools,
      // Use stopWhen instead of maxSteps (AI SDK 5.0)
      stopWhen: stepCountIs(5), // Stop at step 10 if tools were called
      temperature: 0.1, // Low temperature for factual, deterministic tool usage
      topP: 0.9,
      maxOutputTokens: 4096,
      // Enable Vercel AI SDK telemetry for automatic tracing
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'kg-chat-tool-calling',
      },
    });
  }

  /**
   * Generate backend tools for KG analysis
   * Backend tool: searchBiomedicalContext (Tavily search)
   * Frontend tools: 27+ tools from kg-tools.ts (metadata only, execution client-side)
   */
  private generateKGTools() {
    const kgTools: Record<string, any> = {};

    // ========================================================================
    // BACKEND TOOL: Tavily Web Search
    // ========================================================================
    if (this.tavilyClient) {
      kgTools.searchBiomedicalContext = tool({
        description:
          'Search for biomedical context, gene functions, disease associations, pathway information, and scientific literature. Use this to gather and cite relevant sources.',
        inputSchema: z.object({
          query: z.string().describe('Search query for biomedical information'),
          includeAnswer: z
            .string()
            .optional()
            .default('true')
            .describe('Include AI-generated answer summary (boolean string)'),
          maxResults: z.string().optional().default('5').describe('Maximum number of results (numeric string 1-10)'),
        }),
        execute: async ({ query, includeAnswer, maxResults }) => {
          const includeAnswerBool =
            typeof includeAnswer === 'string'
              ? ['true', '1', 'yes', 'y'].includes(includeAnswer.toLowerCase())
              : !!includeAnswer;
          const maxResultsNum = typeof maxResults === 'string' ? Number(maxResults) : maxResults;
          try {
            const response = await this.tavilyClient!.search(query, {
              searchDepth: 'advanced',
              topic: 'general',
              includeAnswer: includeAnswerBool,
              maxResults: Number.isFinite(maxResultsNum) ? maxResultsNum : 5,
              includeDomains: [
                'pubmed.ncbi.nlm.nih.gov',
                'www.ncbi.nlm.nih.gov',
                'www.uniprot.org',
                'www.genecards.org',
                'www.ensembl.org',
              ],
            });

            return {
              answer: response.answer || null,
              results: response.results.map((r: any) => ({
                title: r.title,
                url: r.url,
                content: r.content,
                score: r.score,
              })),
              query: response.query,
            };
          } catch (error) {
            return {
              error: error instanceof Error ? error.message : 'Search failed',
              query,
            };
          }
        },
      });
    }

    // ========================================================================
    // FRONTEND TOOLS: Metadata only (execution happens client-side)
    // ========================================================================

    // Graph Query Tools (8 tools)
    kgTools.searchNodes = tool({
      description: 'Search for nodes by label using fuzzy matching. Only returns visible nodes.',
      inputSchema: z.object({
        query: z.string().describe('Search query for node labels'),
        nodeType: z.string().optional().describe('Filter by specific node type'),
        limit: z.string().optional().default('50').describe('Maximum results to return (numeric string)'),
      }),
    });

    kgTools.getNodeProperties = tool({
      description: 'Get all properties for specific nodes. Excludes hidden nodes.',
      inputSchema: z.object({
        nodeIds: z.array(z.string()).describe('Array of node IDs to get properties for'),
      }),
    });

    kgTools.findSimplePaths = tool({
      description:
        'Find simple paths between two nodes using graphology-simple-path. Returns shortest paths first. Excludes paths through hidden nodes.',
      inputSchema: z.object({
        sourceLabelOrId: z.string().describe('Source node label or ID'),
        targetLabelOrId: z.string().describe('Target node label or ID'),
        maxLength: z.string().optional().default('5').describe('Maximum path length (numeric string)'),
        maxPaths: z.string().optional().default('100').describe('Maximum paths to find (numeric string)'),
      }),
    });

    kgTools.getNeighborhood = tool({
      description: 'Get immediate neighbors of node(s). Excludes hidden neighbors.',
      inputSchema: z.object({
        nodeLabelsOrIds: z.array(z.string()).describe('Center node labels or IDs'),
        hops: z.string().optional().default('1').describe('Number of hops (numeric string)'),
      }),
    });

    kgTools.filterSubgraph = tool({
      description: 'Filter graph by node types, edge types, or property conditions. Only returns visible entities.',
      inputSchema: z.object({
        nodeTypes: z.array(z.string()).optional().describe('Filter by node types'),
        edgeTypes: z.array(z.string()).optional().describe('Filter by edge types'),
        propertyConditions: z
          .array(
            z.object({
              property: z.string(),
              operator: z.enum(['=', '>', '<', '>=', '<=']),
              value: z.string().describe('Value (string rep; parse numeric/boolean internally)'),
            }),
          )
          .optional()
          .describe('Property filter conditions'),
      }),
    });

    kgTools.computeCentrality = tool({
      description:
        'Calculate centrality metrics (degree, betweenness, closeness, eigenvector). Only computes for visible nodes.',
      inputSchema: z.object({
        metric: z.enum(['degree', 'betweenness', 'closeness', 'eigenvector']).describe('Centrality metric to compute'),
        nodeIds: z
          .array(z.string())
          .optional()
          .describe('Specific nodes to compute (optional, computes all if omitted)'),
      }),
    });

    kgTools.retrieveRelevantContext = tool({
      description: 'BM25 search + graph expansion for context retrieval. Only returns visible nodes.',
      inputSchema: z.object({
        query: z.string().describe('Query for BM25 search'),
        topK: z.string().optional().default('30').describe('Number of results to retrieve (numeric string)'),
      }),
    });

    kgTools.extractSubgraph = tool({
      description: 'Extract subgraph and format as structured JSON. Excludes hidden entities.',
      inputSchema: z.object({
        nodeIds: z.array(z.string()).describe('Node IDs to extract'),
        includeNeighbors: z.string().optional().default('false').describe('Include 1-hop neighbors (boolean string)'),
      }),
    });

    // Analysis Tools (5 tools)
    kgTools.analyzeCommunities = tool({
      description: 'Detect communities with Louvain algorithm. Only includes visible nodes.',
      inputSchema: z.object({
        resolution: z.string().optional().default('1').describe('Louvain resolution parameter (numeric string)'),
        weighted: z.string().optional().default('false').describe('Use edge weights for clustering (boolean string)'),
        minCommunitySize: z
          .string()
          .optional()
          .default('3')
          .describe('Minimum community size to display (numeric string)'),
      }),
    });

    kgTools.applyDWPC = tool({
      description: 'Degree-Weighted Path Count (DWPC) between two nodes. Excludes paths through hidden nodes.',
      inputSchema: z.object({
        sourceLabelOrId: z.string().describe('Source node'),
        targetLabelOrId: z.string().describe('Target node'),
        damping: z.string().optional().default('0.5').describe('Damping factor (numeric string 0-1)'),
        maxHops: z.string().optional().default('5').describe('Maximum hops to search (numeric string)'),
        maxPaths: z.string().optional().default('10000').describe('Maximum paths to find (numeric string)'),
      }),
    });

    kgTools.applyGSEA = tool({
      description: 'Gene Set Enrichment Analysis (GSEA) via Python backend. Only works with Gene nodes.',
      inputSchema: z.object({
        geneNames: z.array(z.string()).describe('Gene names for GSEA'),
      }),
    });

    kgTools.computeNetworkStatistics = tool({
      description: 'Compute overall graph metrics. Only computes for visible nodes/edges.',
      inputSchema: z.object({}),
    });

    kgTools.expandContext = tool({
      description: 'Expand existing subgraph with neighbors or paths. Only adds visible nodes.',
      inputSchema: z.object({
        currentNodeIds: z.array(z.string()).describe('Current node set (ENSEMBL IDs not Gene Symbols)'),
        expansionStrategy: z.enum(['neighbors', 'pathBased']).describe('How to expand'),
        depth: z.string().optional().default('1').describe('Expansion depth (numeric string)'),
      }),
    });

    // Visualization Tools (10 tools)
    kgTools.highlightNodes = tool({
      description: 'Highlight nodes and zoom camera to them.',
      inputSchema: z.object({
        nodeLabelsOrIds: z.array(z.string()).describe('Nodes to highlight'),
        color: z
          .string()
          .optional()
          .describe("Don't use this unless highlight color is specified by the user (hex or css name)"),
      }),
    });

    kgTools.filterByNodeType = tool({
      description: 'Show or hide nodes by type.',
      inputSchema: z.object({
        nodeType: z.string().describe('Node type to filter'),
        visible: z.string().describe('Show or hide this node type (boolean string)'),
      }),
    });

    kgTools.listAvailableProperties = tool({
      description:
        'Search for available properties by query. CRITICAL: Query is REQUIRED - too many properties to list without filtering.',
      inputSchema: z.object({
        query: z.string().describe('Search query for properties (REQUIRED)'),
        nodeType: z.string().optional().describe('Filter by node type'),
        limit: z.string().optional().default('20').describe('Maximum results (numeric string)'),
      }),
    });

    kgTools.applyNodeColorByProperty = tool({
      description:
        'Map node color to property value. CRITICAL: For Gene nodes, use category names (DEG, Pathway, etc.). For other nodes, use individual property names. Call listAvailableProperties first.',
      inputSchema: z.object({
        nodeType: z.string().describe('Node type to apply property to'),
        propertyName: z.string().describe('Property name or category (for Gene nodes)'),
      }),
    });

    kgTools.applyNodeSizeByProperty = tool({
      description:
        'Map node size to property value. CRITICAL: For Gene nodes, use category names (DEG, Pathway, etc.). For other nodes, use individual property names. Call listAvailableProperties first.',
      inputSchema: z.object({
        nodeType: z.string().describe('Node type to apply property to'),
        propertyName: z.string().describe('Property name or category (for Gene nodes)'),
      }),
    });

    kgTools.updateEdgeStyle = tool({
      description: 'Update edge visual styling (color, width, opacity).',
      inputSchema: z.object({
        edgeIds: z.array(z.string()).optional().describe('Specific edge IDs (optional, updates all if omitted)'),
        color: z.string().optional().describe('Edge color'),
        width: z.string().optional().describe('Edge width (numeric string)'),
        opacity: z.string().optional().describe('Edge opacity (numeric string 0-1)'),
      }),
    });

    kgTools.filterByEdgeWeight = tool({
      description: 'Filter edges by minimum weight threshold.',
      inputSchema: z.object({
        edgeWeightCutoff: z.string().describe('Minimum edge weight (numeric string 0-1)'),
      }),
    });

    kgTools.filterByNodeDegree = tool({
      description: 'Filter nodes by minimum degree threshold.',
      inputSchema: z.object({
        minDegree: z.string().describe('Minimum node degree (numeric string)'),
      }),
    });

    // Interaction Tools (4 tools)
    kgTools.clickNode = tool({
      description: 'Select/click a specific node.',
      inputSchema: z.object({
        nodeLabelOrId: z.string().describe('Node to click/select'),
      }),
    });

    kgTools.clickEdge = tool({
      description: 'Select/click a specific edge by source and target.',
      inputSchema: z.object({
        sourceId: z.string().describe('Source node ID'),
        targetId: z.string().describe('Target node ID'),
      }),
    });

    kgTools.selectMultipleNodes = tool({
      description: 'Select multiple nodes at once for showing details.',
      inputSchema: z.object({
        nodeLabelsOrIds: z.array(z.string()).describe('Nodes to select'),
        append: z
          .string()
          .optional()
          .default('false')
          .describe('Append to existing selection or replace (boolean string)'),
      }),
    });

    kgTools.clearSelection = tool({
      description: 'Clear all node/edge selections.',
      inputSchema: z.object({}),
    });

    // Utility Tools (1 tool)
    kgTools.takeScreenshot = tool({
      description:
        'Capture screenshot of current graph visualization for visual analysis. Returns base64-encoded PNG image.',
      inputSchema: z.object({}),
    });

    return kgTools;
  }
}
