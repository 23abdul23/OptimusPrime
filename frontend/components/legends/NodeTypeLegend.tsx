'use client';

import type EventEmitter from 'events';
import { EyeIcon, EyeOffIcon, SearchIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { applyKnowledgeGraphStyling, FADED_NODE_COLOR, generateTypeColorMap } from '@/lib/graph/knowledge-graph-renderer';
import { useKGStore } from '@/lib/hooks';
import { applyOptimusGraph, fetchOptimusSubgraph, searchOptimusNodes, type OptimusSearchResult } from '@/lib/optimuskg';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ScrollArea } from '../ui/scroll-area';
import { Spinner } from '../ui/spinner';

interface NodeTypeInfo {
  type: string;
  color: string;
  total: number;
  visible: number;
  hidden: boolean;
}

/**
 * NodeTypeLegend - live legend for the currently rendered graph.
 * Clicking a type opens a category-scoped OptimusKG browser.
 */
export function NodeTypeLegend() {
  const sigmaInstance = useKGStore((state) => state.sigmaInstance);
  const activePropertyNodeTypes = useKGStore((state) => state.activePropertyNodeTypes);
  const optimusQueryOptions = useKGStore((state) => state.optimusQueryOptions);
  const [nodeTypes, setNodeTypes] = useState<NodeTypeInfo[]>([]);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeType, setActiveType] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<OptimusSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [loadingNodeId, setLoadingNodeId] = useState<string | null>(null);
  const hiddenTypesRef = useRef(hiddenTypes);

  useEffect(() => {
    hiddenTypesRef.current = hiddenTypes;
  }, [hiddenTypes]);

  const refreshNodeTypes = useCallback(() => {
    if (!sigmaInstance) {
      setNodeTypes([]);
      return;
    }

    const graph = sigmaInstance.getGraph();
    const typeColorMap = generateTypeColorMap(graph);
    const typeCountMap = new Map<string, { total: number; visible: number }>();

    graph.forEachNode((_node, attr) => {
      const nodeType = (attr.nodeType as string) || 'Unknown';
      const counts = typeCountMap.get(nodeType) ?? { total: 0, visible: 0 };
      counts.total += 1;
      if (attr.hidden !== true) {
        counts.visible += 1;
      }
      typeCountMap.set(nodeType, counts);
    });

    const typesArray = Array.from(typeCountMap.entries())
      .map(([type, counts]) => ({
        type,
        color: typeColorMap.get(type) || '#6b7280',
        total: counts.total,
        visible: counts.visible,
        hidden: hiddenTypesRef.current.has(type),
      }))
      .sort((a, b) => b.visible - a.visible || b.total - a.total || a.type.localeCompare(b.type));

    setNodeTypes(typesArray);
  }, [sigmaInstance]);

  useEffect(() => {
    if (!sigmaInstance) {
      return;
    }

    refreshNodeTypes();
    const listener = () => refreshNodeTypes();
    (sigmaInstance as EventEmitter).on('loaded', listener);

    return () => {
      (sigmaInstance as EventEmitter).off('loaded', listener);
    };
  }, [sigmaInstance, refreshNodeTypes]);

  useEffect(() => {
    if (!dialogOpen || !activeType) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setSearchLoading(true);
      searchOptimusNodes(trimmedQuery, 16, [activeType])
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
  }, [dialogOpen, activeType, searchQuery]);

  const toggleTypeVisibility = (nodeType: string) => {
    const graph = sigmaInstance?.getGraph();
    if (!graph) return;
    const newHiddenTypes = new Set(hiddenTypes);

    if (hiddenTypes.has(nodeType)) {
      newHiddenTypes.delete(nodeType);
      graph.updateEachNodeAttributes((_node, attr) => {
        if ((attr.nodeType as string) === nodeType) {
          attr.hidden = false;
        }
        return attr;
      });
    } else {
      newHiddenTypes.add(nodeType);
      graph.updateEachNodeAttributes((_node, attr) => {
        if ((attr.nodeType as string) === nodeType) {
          attr.hidden = true;
        }
        return attr;
      });
    }

    setHiddenTypes(newHiddenTypes);
    sigmaInstance?.refresh();
    refreshNodeTypes();
  };

  const changeTypeColor = async (nodeType: string, newColor: string) => {
    const graph = sigmaInstance?.getGraph();
    if (!graph) return;

    graph.forEachNode((nodeId, attr) => {
      if ((attr.nodeType as string) === nodeType) {
        graph.setNodeAttribute(nodeId, 'color', newColor);
        if (attr.type === 'border') {
          graph.setNodeAttribute(nodeId, 'borderColor', newColor);
        }
      }
    });

    await applyKnowledgeGraphStyling(graph);
    setNodeTypes((prev) => prev.map((entry) => (entry.type === nodeType ? { ...entry, color: newColor } : entry)));
    sigmaInstance?.refresh();
  };

  const openTypeBrowser = (nodeType: string) => {
    setActiveType(nodeType);
    setSearchQuery('');
    setSearchResults([]);
    setDialogOpen(true);
  };

  const handleNodeSelection = async (result: OptimusSearchResult) => {
    if (!sigmaInstance) {
      toast.error('Graph renderer is not ready yet');
      return;
    }

    setLoadingNodeId(result.id);
    try {
      const payload = await fetchOptimusSubgraph(result.id, optimusQueryOptions);
      await applyOptimusGraph(sigmaInstance, payload, 'replace', [result.id]);
      setDialogOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      toast.success(`Loaded ${result.typeName} neighborhood`, {
        description: `${payload.nodes.length} nodes, ${payload.edges.length} edges`,
      });
    } catch (error) {
      console.error(error);
      toast.error('Failed to load category node', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setLoadingNodeId(null);
    }
  };

  if (nodeTypes.length === 0) {
    return (
      <div className='space-y-1'>
        <p className='font-semibold text-[10px] text-gray-600 uppercase'>Node Types</p>
        <p className='text-[11px] text-gray-500'>No node types in the current graph yet.</p>
      </div>
    );
  }

  return (
    <>
      <div className='space-y-1'>
        <div className='flex items-center justify-between'>
          <p className='font-semibold text-[10px] text-gray-600 uppercase'>Node Types</p>
          <span className='text-[10px] text-gray-500'>Click a type to browse</span>
        </div>
        <div className='space-y-0.5'>
          {nodeTypes.map(({ type, color, total, visible, hidden }) => {
            const hasBorderEffect = activePropertyNodeTypes.length !== 0 && !activePropertyNodeTypes.includes(type);

            return (
              <div
                key={type}
                role='button'
                tabIndex={0}
                className={cn(
                  'flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] transition-colors hover:bg-slate-50',
                  hidden && 'opacity-50',
                )}
                onClick={() => openTypeBrowser(type)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openTypeBrowser(type);
                  }
                }}
              >
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type='button'
                      className='relative flex size-4 shrink-0 items-center justify-center rounded-sm ring-1 ring-gray-300 transition-all hover:ring-2 hover:ring-gray-400'
                      style={{
                        backgroundColor: hasBorderEffect ? FADED_NODE_COLOR : color,
                      }}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {hasBorderEffect && (
                        <div
                          className='absolute inset-0 rounded-sm'
                          style={{
                            border: `2px solid ${color}`,
                          }}
                        />
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className='w-36 md:w-64' align='end'>
                    <div className='flex flex-wrap gap-1'>
                      {[
                        'black',
                        'hotpink',
                        'orange',
                        'yellow',
                        'limegreen',
                        'aquamarine',
                        'skyblue',
                        'darkorchid',
                        'blue',
                      ].map((presetColor) => (
                        <button
                          type='button'
                          key={presetColor}
                          style={{ background: presetColor }}
                          onClick={(event) => {
                            event.stopPropagation();
                            void changeTypeColor(type, presetColor);
                          }}
                          className='size-6 cursor-pointer rounded-md hover:scale-105'
                        />
                      ))}
                    </div>
                    <Input
                      value={color}
                      className='col-span-2 mt-4 h-8'
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => void changeTypeColor(type, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          void changeTypeColor(type, event.currentTarget.value);
                        }
                      }}
                    />
                  </PopoverContent>
                </Popover>

                <span className='min-w-0 flex-1 truncate font-medium' title={type}>
                  {type}
                </span>

                <button
                  type='button'
                  className='rounded px-1 text-[10px] text-sky-700 hover:bg-sky-100'
                  onClick={(event) => {
                    event.stopPropagation();
                    openTypeBrowser(type);
                  }}
                >
                  <SearchIcon className='size-3' />
                </button>

                <span className='shrink-0 text-[10px] text-gray-500'>
                  {visible}/{total}
                </span>

                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  className='size-5 shrink-0'
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleTypeVisibility(type);
                  }}
                >
                  {hidden ? <EyeOffIcon className='size-3' /> : <EyeIcon className='size-3' />}
                </Button>
              </div>
            );
          })}
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className='max-h-[80vh] max-w-2xl overflow-hidden'>
          <DialogHeader>
            <DialogTitle>{activeType ?? 'Node Type'} Browser</DialogTitle>
            <DialogDescription>
              Search within the selected node category and load a fresh neighborhood around any result.
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-3'>
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={`Search ${activeType ?? 'nodes'} by name, symbol, ID, or alias...`}
              className='h-9'
            />

            <ScrollArea className='h-80 rounded border border-slate-200 bg-slate-50 p-2'>
              {searchLoading ? (
                <div className='flex h-full items-center justify-center text-sm text-slate-500'>
                  <Spinner size='small' />
                  <span className='ml-2'>Searching {activeType ?? 'nodes'}...</span>
                </div>
              ) : searchQuery.trim().length < 2 ? (
                <div className='flex h-full items-center justify-center text-sm text-slate-500'>
                  Type at least 2 characters to search within {activeType ?? 'this category'}.
                </div>
              ) : searchResults.length === 0 ? (
                <div className='flex h-full items-center justify-center text-sm text-slate-500'>
                  No matches found in {activeType ?? 'this category'}.
                </div>
              ) : (
                <div className='space-y-2'>
                  {searchResults.map((result) => (
                    <button
                      type='button'
                      key={result.id}
                      className='w-full rounded border border-slate-200 bg-white p-3 text-left transition hover:border-sky-200 hover:bg-sky-50'
                      onClick={() => void handleNodeSelection(result)}
                      disabled={loadingNodeId !== null}
                    >
                      <div className='flex items-start justify-between gap-3'>
                        <div className='min-w-0'>
                          <div className='truncate font-medium text-slate-900'>{result.displayName}</div>
                          <div className='truncate text-xs text-slate-500'>
                            {result.typeName} - {result.id}
                          </div>
                          {result.matchedOn.length > 0 && (
                            <div className='mt-1 text-[11px] text-sky-700'>
                              Matched on: {result.matchedOn.join(', ')}
                            </div>
                          )}
                        </div>
                        {loadingNodeId === result.id ? (
                          <Spinner size='small' />
                        ) : (
                          <span className='shrink-0 text-[11px] font-medium text-sky-700'>Load graph</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
