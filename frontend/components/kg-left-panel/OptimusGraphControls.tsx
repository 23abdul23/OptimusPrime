'use client';

import {
  ChevronDownIcon,
  ChevronUpIcon,
  DatabaseIcon,
  GitBranchPlusIcon,
  RouteIcon,
  SearchIcon,
  ShuffleIcon,
  Trash2Icon,
} from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';
import { useKGStore } from '@/lib/hooks';
import {
  applyOptimusGraph,
  clearRenderedKnowledgeGraph,
  fetchOptimusExpansion,
  fetchOptimusShortestPath,
  fetchOptimusStats,
  fetchOptimusSubgraph,
  fetchRandomOptimusNode,
  highlightOptimusPath,
  searchOptimusNodes,
  type OptimusGraphStats,
  type OptimusSearchResult,
} from '@/lib/optimuskg';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { ScrollArea } from '../ui/scroll-area';
import { Spinner } from '../ui/spinner';

export function OptimusGraphControls() {
  const MAX_RADIUS = 15;
  const MAX_NODES = 5000;
  const MAX_DEGREE_LIMIT = 35;
  const sigmaInstance = useKGStore((state) => state.sigmaInstance);
  const selectedNodes = useKGStore((state) => state.selectedNodes);
  const [collapsed, setCollapsed] = React.useState(false);
  const [stats, setStats] = React.useState<OptimusGraphStats | null>(null);
  const [statsError, setStatsError] = React.useState<string | null>(null);
  const [statsLoading, setStatsLoading] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchLoading, setSearchLoading] = React.useState(false);
  const [searchResults, setSearchResults] = React.useState<OptimusSearchResult[]>([]);
  const [radius, setRadius] = React.useState('10');
  const [maxNodes, setMaxNodes] = React.useState('3000');
  const [degreeLimit, setDegreeLimit] = React.useState('25');
  const [pathDepth, setPathDepth] = React.useState('6');
  const [pathSourceId, setPathSourceId] = React.useState('');
  const [pathTargetId, setPathTargetId] = React.useState('');
  const [pathSourceLoading, setPathSourceLoading] = React.useState(false);
  const [pathTargetLoading, setPathTargetLoading] = React.useState(false);
  const [pathSourceResults, setPathSourceResults] = React.useState<OptimusSearchResult[]>([]);
  const [pathTargetResults, setPathTargetResults] = React.useState<OptimusSearchResult[]>([]);
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    setStatsLoading(true);
    setStatsError(null);
    fetchOptimusStats()
      .then(setStats)
      .catch((error) => {
        console.error(error);
        setStatsError(error instanceof Error ? error.message : 'Unknown error');
      })
      .finally(() => {
        setStatsLoading(false);
      });
  }, []);

  React.useEffect(() => {
    if (selectedNodes.length > 0) {
      setPathSourceId(selectedNodes[0]);
    }

    if (selectedNodes.length > 1) {
      setPathTargetId(selectedNodes[1]);
    } else if (selectedNodes.length <= 1) {
      setPathTargetId('');
    }
  }, [selectedNodes]);

  React.useEffect(() => {
    const trimmedQuery = searchQuery.trim();

    if (trimmedQuery.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setSearchLoading(true);
      searchOptimusNodes(trimmedQuery, 12)
        .then((results) => {
          if (!cancelled) {
            setSearchResults(results);
          }
        })
        .catch((error) => {
          console.error(error);
          if (!cancelled) {
            setSearchResults([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearchLoading(false);
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [searchQuery]);

  React.useEffect(() => {
    const trimmedQuery = pathSourceId.trim();

    if (trimmedQuery.length < 2) {
      setPathSourceResults([]);
      setPathSourceLoading(false);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setPathSourceLoading(true);
      searchOptimusNodes(trimmedQuery, 8)
        .then((results) => {
          if (!cancelled) {
            setPathSourceResults(results);
          }
        })
        .catch((error) => {
          console.error(error);
          if (!cancelled) {
            setPathSourceResults([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setPathSourceLoading(false);
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [pathSourceId]);

  React.useEffect(() => {
    const trimmedQuery = pathTargetId.trim();

    if (trimmedQuery.length < 2) {
      setPathTargetResults([]);
      setPathTargetLoading(false);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setPathTargetLoading(true);
      searchOptimusNodes(trimmedQuery, 8)
        .then((results) => {
          if (!cancelled) {
            setPathTargetResults(results);
          }
        })
        .catch((error) => {
          console.error(error);
          if (!cancelled) {
            setPathTargetResults([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setPathTargetLoading(false);
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [pathTargetId]);

  const parsedRadius = React.useMemo(
    () => Math.min(MAX_RADIUS, Math.max(1, Number.parseInt(radius, 10) || 1)),
    [radius],
  );
  const parsedMaxNodes = React.useMemo(
    () => Math.min(MAX_NODES, Math.max(50, Number.parseInt(maxNodes, 10) || 250)),
    [maxNodes],
  );
  const parsedDegreeLimit = React.useMemo(
    () => Math.min(MAX_DEGREE_LIMIT, Math.max(1, Number.parseInt(degreeLimit, 10) || 12)),
    [degreeLimit],
  );
  const parsedPathDepth = React.useMemo(() => Math.max(1, Number.parseInt(pathDepth, 10) || 6), [pathDepth]);

  React.useEffect(() => {
    const currentOptions = useKGStore.getState().optimusQueryOptions;
    if (
      currentOptions.radius === parsedRadius &&
      currentOptions.maxNodes === parsedMaxNodes &&
      currentOptions.degreeLimit === parsedDegreeLimit
    ) {
      return;
    }

    useKGStore.setState({
      optimusQueryOptions: {
        radius: parsedRadius,
        maxNodes: parsedMaxNodes,
        degreeLimit: parsedDegreeLimit,
      },
    });
  }, [parsedRadius, parsedMaxNodes, parsedDegreeLimit]);

  function showLimitNotice() {
    const requestedRadius = Number.parseInt(radius, 10) || 1;
    const requestedMaxNodes = Number.parseInt(maxNodes, 10) || 250;
    const requestedDegreeLimit = Number.parseInt(degreeLimit, 10) || 12;

    if (
      requestedRadius > MAX_RADIUS ||
      requestedMaxNodes > MAX_NODES ||
      requestedDegreeLimit > MAX_DEGREE_LIMIT
    ) {
      toast.info('Large graph settings were capped for stability', {
        description: `Radius ${parsedRadius}, max nodes ${parsedMaxNodes}, degree limit ${parsedDegreeLimit}`,
      });
    }
  }

  async function replaceWithSubgraph(nodeId: string) {
    if (!sigmaInstance) {
      toast.error('Graph renderer is not ready yet');
      return;
    }

    setWorking(true);
    try {
      showLimitNotice();
      const payload = await fetchOptimusSubgraph(nodeId, {
        radius: parsedRadius,
        maxNodes: parsedMaxNodes,
        degreeLimit: parsedDegreeLimit,
      });

      await applyOptimusGraph(sigmaInstance, payload, 'replace', [nodeId]);
      toast.success('Loaded OptimusKG subgraph', {
        description: `${payload.nodes.length} nodes, ${payload.edges.length} edges`,
      });
    } catch (error) {
      console.error(error);
      toast.error('Failed to load OptimusKG subgraph', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setWorking(false);
    }
  }

  async function mergeExpansion(nodeIds: string[]) {
    if (!sigmaInstance) {
      toast.error('Graph renderer is not ready yet');
      return;
    }

    if (nodeIds.length === 0) {
      toast.error('Select or search at least one node to expand');
      return;
    }

    setWorking(true);
    try {
      showLimitNotice();
      const payload = await fetchOptimusExpansion(nodeIds, {
        hops: parsedRadius,
        maxNodes: parsedMaxNodes,
        degreeLimit: parsedDegreeLimit,
      });

      await applyOptimusGraph(sigmaInstance, payload, 'merge', nodeIds);
      toast.success('Expanded OptimusKG graph', {
        description: `${payload.nodes.length} nodes, ${payload.edges.length} edges fetched`,
      });
    } catch (error) {
      console.error(error);
      toast.error('Failed to expand graph', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setWorking(false);
    }
  }

  async function handleExpandSelected() {
    if (selectedNodes.length === 0) {
      toast.error('Select or search at least one node to expand');
      return;
    }

    await mergeExpansion(selectedNodes);
  }

  async function handleSearch() {
    if (searchQuery.trim().length < 2) {
      toast.error('Enter at least 2 characters to search OptimusKG');
      return;
    }

    setSearchLoading(true);
    try {
      const results = await searchOptimusNodes(searchQuery.trim(), 12);
      setSearchResults(results);
    } catch (error) {
      console.error(error);
      toast.error('Failed to search OptimusKG', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setSearchLoading(false);
    }
  }

  function highlightNodeInCurrentGraph(nodeId: string) {
    if (!sigmaInstance) {
      return false;
    }

    const graph = sigmaInstance.getGraph();
    if (!graph.hasNode(nodeId)) {
      return false;
    }

    useKGStore.setState({
      nodeSearchQuery: nodeId,
    });
    useKGStore.getState().setGraphSelection({ nodeIds: [nodeId], edgeIds: [] });
    sigmaInstance.refresh();
    return true;
  }

  async function handleSuggestionSelect(result: OptimusSearchResult) {
    setSearchQuery(result.displayName);
    if (highlightNodeInCurrentGraph(result.id)) {
      toast.success('Highlighted node in graph', {
        description: result.displayName,
      });
      return;
    }

    await replaceWithSubgraph(result.id);
    useKGStore.setState({
      nodeSearchQuery: result.id,
    });
    useKGStore.getState().setGraphSelection({ nodeIds: [result.id], edgeIds: [] });
  }

  async function handleRandomLoad() {
    setWorking(true);
    try {
      const node = await fetchRandomOptimusNode();
      if (!node) {
        toast.error('No OptimusKG nodes are available in Neo4j yet');
        return;
      }
      await replaceWithSubgraph(node.id);
    } catch (error) {
      console.error(error);
      toast.error('Failed to load a random OptimusKG neighborhood', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setWorking(false);
    }
  }

  async function handleClearNetwork() {
    if (!sigmaInstance) {
      toast.error('Graph renderer is not ready yet');
      return;
    }

    setWorking(true);
    try {
      await clearRenderedKnowledgeGraph(sigmaInstance);
      setSearchQuery('');
      setSearchResults([]);
      setPathSourceId('');
      setPathTargetId('');
      toast.success('Cleared the current knowledge graph');
    } catch (error) {
      console.error(error);
      toast.error('Failed to clear the current graph', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setWorking(false);
    }
  }

  async function loadPathBetween(sourceId: string, targetId: string) {
    if (!sigmaInstance) {
      toast.error('Graph renderer is not ready yet');
      return;
    }

    if (!sourceId || !targetId) {
      toast.error('Provide both source and target node IDs for path discovery');
      return;
    }

    setWorking(true);
    try {
      const response = await fetchOptimusShortestPath(sourceId.trim(), targetId.trim(), parsedPathDepth);
      if (!response.found) {
        toast.error('No path found between those OptimusKG nodes');
        return;
      }

      await applyOptimusGraph(
        sigmaInstance,
        response.graph,
        'merge',
        response.graph.nodes.map((node) => node.key),
      );
      highlightOptimusPath(
        sigmaInstance,
        response.graph.nodes.map((node) => node.key),
        response.graph.edges.map((edge) => edge.key),
      );
      toast.success('Loaded shortest path from OptimusKG', {
        description: `${response.graph.nodes.length} nodes, ${response.graph.edges.length} edges`,
      });
    } catch (error) {
      console.error(error);
      toast.error('Failed to load shortest path', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setWorking(false);
    }
  }

  async function handleLoadPath() {
    await loadPathBetween(pathSourceId, pathTargetId);
  }

  function handlePathNodeSelect(field: 'source' | 'target', result: OptimusSearchResult) {
    if (field === 'source') {
      setPathSourceId(result.id);
      setPathSourceResults([]);
      return;
    }

    setPathTargetId(result.id);
    setPathTargetResults([]);
  }

  function renderPathSearchResults(
    field: 'source' | 'target',
    results: OptimusSearchResult[],
    loading: boolean,
    currentValue: string,
  ) {
    if (currentValue.trim().length < 2) {
      return null;
    }

    return (
      <div className='rounded border border-sky-100 bg-white p-2'>
        {loading ? (
          <div className='flex items-center text-[11px] text-slate-500'>
            <Spinner size='small' />
            <span className='ml-2'>Searching nodes...</span>
          </div>
        ) : results.length > 0 ? (
          <ScrollArea className='h-24'>
            <div className='space-y-1 pr-2'>
              {results.map((result) => (
                <button
                  type='button'
                  key={`${field}-${result.id}`}
                  className='w-full rounded border border-slate-100 px-2 py-1 text-left text-[11px] transition hover:border-sky-200 hover:bg-sky-50'
                  onClick={() => handlePathNodeSelect(field, result)}
                >
                  <div className='truncate font-medium text-slate-900'>{result.displayName}</div>
                  <div className='truncate text-slate-500'>
                    {result.typeName} - {result.id}
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <div className='text-[11px] text-slate-500'>No matching nodes found.</div>
        )}
      </div>
    );
  }

  return (
    <div className='mb-3 rounded-lg border border-sky-200 bg-sky-50 p-3'>
      <div className='mb-3 flex items-start justify-between gap-2'>
        <div>
          <div className='flex items-center gap-2 font-semibold text-sky-950 text-sm'>
            <DatabaseIcon className='size-4' />
            OptimusKG Data
          </div>
        </div>
        <div className='flex items-center gap-2'>
          {(working || statsLoading) && <Spinner size='small' />}
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='size-7 text-sky-900'
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <ChevronDownIcon className='size-4' /> : <ChevronUpIcon className='size-4' />}
          </Button>
        </div>
      </div>

      {!collapsed && stats && (
        <div className='mb-3 space-y-3 text-xs'>
          <div className='grid grid-cols-2 gap-2'>
            <div className='rounded border border-sky-100 bg-white px-2 py-1'>
              <div className='text-sky-700'>Nodes</div>
              <div className='font-semibold text-sky-950'>{stats.nodeCount.toLocaleString()}</div>
            </div>
            <div className='rounded border border-sky-100 bg-white px-2 py-1'>
              <div className='text-sky-700'>Edges</div>
              <div className='font-semibold text-sky-950'>{stats.edgeCount.toLocaleString()}</div>
            </div>
            <div className='rounded border border-sky-100 bg-white px-2 py-1'>
              <div className='text-sky-700'>Node Types</div>
              <div className='font-semibold text-sky-950'>{stats.nodeTypes.length.toLocaleString()}</div>
            </div>
            <div className='rounded border border-sky-100 bg-white px-2 py-1'>
              <div className='text-sky-700'>Relation Types</div>
              <div className='font-semibold text-sky-950'>{stats.relationshipTypes.length.toLocaleString()}</div>
            </div>
          </div>

          <div className='rounded border border-sky-100 bg-white p-2'>
            <div className='mb-2 flex items-center justify-between text-[11px]'>
              <span className='font-semibold text-sky-950'>Node Type Breakdown</span>
              <span className='text-sky-700'>{stats.nodeTypes.length}</span>
            </div>
            <ScrollArea className='h-28 pr-2'>
              <div className='space-y-1'>
                {stats.nodeTypes.map((nodeType) => (
                  <div key={`${nodeType.typeCode}-${nodeType.typeName}`} className='flex items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1'>
                    <div className='min-w-0'>
                      <div className='truncate font-medium text-slate-900'>{nodeType.typeName}</div>
                      <div className='truncate text-slate-500'>{nodeType.typeCode}</div>
                    </div>
                    <div className='shrink-0 font-semibold text-sky-900'>{nodeType.count.toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          <div className='rounded border border-sky-100 bg-white p-2'>
            <div className='mb-2 flex items-center justify-between text-[11px]'>
              <span className='font-semibold text-sky-950'>Relationship Breakdown</span>
              <span className='text-sky-700'>{stats.relationshipTypes.length}</span>
            </div>
            <ScrollArea className='h-24 pr-2'>
              <div className='space-y-1'>
                {stats.relationshipTypes.map((relation) => (
                  <div key={relation.relation} className='flex items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1'>
                    <div className='truncate font-medium text-slate-900'>{relation.relation}</div>
                    <div className='shrink-0 font-semibold text-sky-900'>{relation.count.toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      )}

      {!collapsed && statsError && (
        <div className='mb-3 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900'>
          Stats unavailable: {statsError}
        </div>
      )}

      {(
        <>
      <div className='grid grid-cols-3 gap-2'>
        <div>
          <Label className='text-[11px]'>Radius</Label>
          <Input value={radius} onChange={(e) => setRadius(e.target.value)} className='h-8 bg-white text-xs' />
        </div>
        <div>
          <Label className='text-[11px]'>Max Nodes</Label>
          <Input value={maxNodes} onChange={(e) => setMaxNodes(e.target.value)} className='h-8 bg-white text-xs' />
        </div>
        <div>
          <Label className='text-[11px]'>Degree Limit</Label>
          <Input
            value={degreeLimit}
            onChange={(e) => setDegreeLimit(e.target.value)}
            className='h-8 bg-white text-xs'
          />
        </div>
      </div>
      <p className='mt-2 text-[11px] text-sky-800'>
        Safety caps: radius {MAX_RADIUS}, max nodes {MAX_NODES.toLocaleString()}, degree limit {MAX_DEGREE_LIMIT}.
      </p>

      <div className='mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3'>
        <Button
          size='sm'
          className='min-w-0 justify-center bg-sky-700 px-2 text-[11px] hover:bg-sky-800'
          onClick={handleRandomLoad}
          disabled={working}
        >
          <ShuffleIcon className='size-3' />
          Random
        </Button>
        <Button
          size='sm'
          variant='outline'
          className='min-w-0 justify-center bg-white px-2 text-[11px]'
          onClick={() => void handleExpandSelected()}
          disabled={working || selectedNodes.length === 0}
        >
          <GitBranchPlusIcon className='size-3' />
          Expand
        </Button>
        <Button
          size='sm'
          variant='outline'
          className='min-w-0 justify-center bg-white px-2 text-[11px]'
          onClick={handleClearNetwork}
          disabled={working}
        >
          <Trash2Icon className='size-3' />
          Clear
        </Button>
      </div>

      {selectedNodes.length === 2 && (
        <div className='mt-3 rounded border border-sky-200 bg-white px-3 py-2 text-[11px] text-sky-950'>
          <div className='font-medium'>Two nodes selected</div>
          <div className='mt-1 text-sky-800'>
            Suggestion: load the shortest path between <span className='font-medium'>{selectedNodes[0]}</span> and{' '}
            <span className='font-medium'>{selectedNodes[1]}</span>.
          </div>
          <Button
            size='sm'
            className='mt-2 h-7 bg-sky-700 px-2 text-[11px] hover:bg-sky-800'
            onClick={() => {
              setPathSourceId(selectedNodes[0]);
              setPathTargetId(selectedNodes[1]);
              void loadPathBetween(selectedNodes[0], selectedNodes[1]);
            }}
            disabled={working}
          >
            <RouteIcon className='size-3' />
            Load Suggested Path
          </Button>
        </div>
      )}

      <div className='mt-4 space-y-2'>
        <Label className='text-[11px]'>Search OptimusKG Nodes</Label>
        <div className='flex gap-2'>
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder='Start typing a gene, disease, drug, pathway, or entity ID...'
            className='h-8 bg-white text-xs'
          />
          <Button size='sm' variant='outline' className='bg-white' onClick={handleSearch} disabled={searchLoading}>
            <SearchIcon className='size-3' />
            Search
          </Button>
        </div>
        <p className='text-[11px] text-sky-800'>Suggestions appear while you type. Click a result to load its connected neighborhood.</p>
      </div>

      {searchQuery.trim().length >= 2 && (
        <ScrollArea className='mt-2 h-36 rounded border border-sky-100 bg-white p-2'>
          {searchLoading ? (
            <div className='flex h-full items-center justify-center text-xs text-slate-500'>
              <Spinner size='small' />
              <span className='ml-2'>Searching OptimusKG...</span>
            </div>
          ) : searchResults.length > 0 ? (
            <div className='space-y-2'>
              {searchResults.map((result) => (
                <div
                  key={result.id}
                  role='button'
                  tabIndex={0}
                  aria-disabled={working}
                  className='w-full cursor-pointer rounded border border-slate-100 bg-slate-50 p-2 text-left text-xs transition hover:border-sky-200 hover:bg-sky-50'
                  onClick={() => {
                    if (!working) {
                      void handleSuggestionSelect(result);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!working && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault();
                      void handleSuggestionSelect(result);
                    }
                  }}
                >
                  <div className='font-medium text-slate-900'>{result.displayName}</div>
                  <div className='text-slate-500'>
                    {result.typeName} - {result.id}
                  </div>
                  {result.matchedOn.length > 0 && (
                    <div className='mt-1 text-[11px] text-sky-700'>Matched on: {result.matchedOn.join(', ')}</div>
                  )}
                  <div className='mt-2 flex flex-wrap gap-2'>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='h-7 bg-white px-2 text-[11px]'
                      onClick={(event) => {
                        event.stopPropagation();
                        void mergeExpansion([result.id]);
                      }}
                      disabled={working}
                    >
                      Expand
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='h-7 bg-white px-2 text-[11px]'
                      onClick={(event) => {
                        event.stopPropagation();
                        setPathSourceId(result.id);
                      }}
                    >
                      Use as A
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='h-7 bg-white px-2 text-[11px]'
                      onClick={(event) => {
                        event.stopPropagation();
                        setPathTargetId(result.id);
                      }}
                    >
                      Use as B
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className='flex h-full items-center justify-center text-center text-xs text-slate-500'>
              No OptimusKG matches for &quot;{searchQuery.trim()}&quot;.
            </div>
          )}
        </ScrollArea>
      )}

      <div className='mt-4 space-y-2'>
        <div className='flex items-center gap-2 font-medium text-sky-950 text-xs'>
          <RouteIcon className='size-3' />
          Shortest Path
        </div>
        <div className='space-y-2'>
          <Input
            value={pathSourceId}
            onChange={(e) => setPathSourceId(e.target.value)}
            placeholder='Search or paste source node ID'
            className='h-8 bg-white text-xs'
          />
          {renderPathSearchResults('source', pathSourceResults, pathSourceLoading, pathSourceId)}
        </div>
        <div className='space-y-2'>
          <Input
            value={pathTargetId}
            onChange={(e) => setPathTargetId(e.target.value)}
            placeholder='Search or paste target node ID'
            className='h-8 bg-white text-xs'
          />
          {renderPathSearchResults('target', pathTargetResults, pathTargetLoading, pathTargetId)}
        </div>
        <div className='flex gap-2'>
          <Input
            value={pathDepth}
            onChange={(e) => setPathDepth(e.target.value)}
            placeholder='Max depth'
            className='h-8 bg-white text-xs'
          />
          <Button size='sm' className='bg-sky-700 hover:bg-sky-800' onClick={handleLoadPath} disabled={working}>
            Load Path
          </Button>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
