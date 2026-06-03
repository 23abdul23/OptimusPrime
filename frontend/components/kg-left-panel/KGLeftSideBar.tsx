'use client';

import { DownloadIcon, SquareDashedMousePointerIcon } from 'lucide-react';
import React from 'react';
import { useKGStore, useStore } from '@/lib/hooks';
import type { ToolContext } from '@/lib/kg-tools';
import { buildNodeSearchIndex, buildPropertySearchIndex, KG_TOOLS } from '@/lib/kg-tools';
import { MouseControlMessage } from '../app';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { ScrollArea } from '../ui/scroll-area';
import { Spinner } from '../ui/spinner';
import { Textarea } from '../ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { KGFileSheet } from './KGFileSheet';
import { NodeColorSelector } from './NodeColorSelector';
import { NodeSearch } from './NodeSearch';
import { NodeSizeSelector } from './NodeSizeSelector';
import { OptimusGraphControls } from './OptimusGraphControls';

/**
 * KGLeftSideBar - Neo4j-focused knowledge graph controls and utilities.
 */
export function KGLeftSideBar() {
  const sigmaInstance = useKGStore(state => state.sigmaInstance);

  // Tool testing state
  const [toolName, setToolName] = React.useState<string>('');
  const [toolInput, setToolInput] = React.useState<string>('{}');
  const [toolTesting, setToolTesting] = React.useState<boolean>(false);

  const handleExport = (format: 'jpeg' | 'json' | 'gexf' | 'graphml' | 'csv') => {
    if (!sigmaInstance) return;
    import('../../lib/graph/kg-export').then(mod => {
      mod.exportKnowledgeGraph(sigmaInstance, format);
    });
  };

  /**
   * Handle property change for non-Gene nodes using NodeColorSelector/NodeSizeSelector
   */
  function handleKGPropChange(val: string, type: 'color' | 'size') {
    useKGStore.setState({
      [type === 'color' ? 'selectedNodeColorProperty' : 'selectedNodeSizeProperty']: val,
    });
  }

  /**
   * Test tool execution
   */
  async function handleToolTest() {
    if (!sigmaInstance || !toolName) {
      console.error('No sigma instance or tool name');
      return;
    }

    setToolTesting(true);
    console.group(`🔧 Tool Test: ${toolName}`);
    console.log('Input:', toolInput);

    try {
      const input = JSON.parse(toolInput);
      const graph = sigmaInstance.getGraph();

      // Build indexes if needed
      const graphSearchIndex = buildNodeSearchIndex(graph);
      const kgPropertyOptions = useKGStore.getState().kgPropertyOptions;
      const propertySearchIndex = buildPropertySearchIndex(kgPropertyOptions || {}, useStore.getState().radioOptions);

      const context: ToolContext = {
        store: useKGStore.getState(),
        legacy_store: useStore.getState(),
        graphSearchIndex,
        propertySearchIndex,
      };

      const toolFn = KG_TOOLS[toolName as keyof typeof KG_TOOLS];

      if (!toolFn) {
        console.error(`Tool "${toolName}" not found in KG_TOOLS`);
        console.log('Available tools:', Object.keys(KG_TOOLS));
        return;
      }

      // biome-ignore lint/suspicious/noExplicitAny: tool input
      const result = await toolFn(input as any, context);

      console.log('Result:', result);

      if (result.success) {
        console.log('✅ Tool executed successfully');
        console.log('Data:', result.data);
        if (result.visualUpdate) {
          console.log('Visual Update:', result.visualUpdate);
        }
      } else {
        console.error('❌ Tool failed:', result.error);
      }
    } catch (error) {
      console.error('❌ Error:', error);
    } finally {
      console.groupEnd();
      setToolTesting(false);
    }
  }

  return (
    <ScrollArea className='flex h-[calc(96vh-1.5px)] flex-col border-r p-2'>
      <div className='flex gap-2'>
        {/* Export dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className='w-[calc(100%-1.5rem)]' variant='outline'>
              <DownloadIcon className='mr-2 size-4' />
              Export Graph
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='start'>
            <DropdownMenuItem onClick={() => handleExport('jpeg')}>JPEG</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport('json')}>JSON</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport('gexf')}>GEXF</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport('graphml')}>GraphML</DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport('csv')}>CSV</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Mouse control tooltip */}
        <Tooltip>
          <TooltipTrigger className='relative'>
            <MouseControlMessage className='bottom-3' />
            <SquareDashedMousePointerIcon className='size-4' />
          </TooltipTrigger>
          <TooltipContent align='start' className='max-w-96 text-sm'>
            <ol>
              <li>• Drag nodes to reposition them</li>
              <li>• Click nodes to view properties</li>
              <li>• Click edges to view connection details</li>
              <li>• Use mouse wheel to zoom</li>
            </ol>
          </TooltipContent>
        </Tooltip>
      </div>

      <OptimusGraphControls />

      {/* Legacy disease-mapped/OpenTargets controls are intentionally disabled for the Neo4j-only KG workflow. */}
      <NodeColorSelector onPropChangeAction={val => handleKGPropChange(val, 'color')} />
      <NodeSizeSelector onPropChangeAction={val => handleKGPropChange(val, 'size')} />

      {/* Common controls */}
      <div className='mb-2 flex flex-col space-y-2'>
        <NodeSearch />
        <KGFileSheet />
      </div>

      {/* Tool Testing Section (Temporary) */}
      <div className='mt-4 rounded border border-yellow-500 bg-yellow-50 p-3'>
        <Label className='mb-2 font-bold text-yellow-800'>🧪 Tool Testing</Label>
        <div className='flex flex-col space-y-2'>
          <div>
            <Label className='text-xs'>Tool Name</Label>
            <Input
              placeholder='e.g., searchNodes'
              value={toolName}
              onChange={e => setToolName(e.target.value)}
              className='text-xs'
            />
          </div>
          <div>
            <Label className='text-xs'>Input (JSON)</Label>
            <Textarea
              placeholder='{"query": "BRCA1", "limit": 5}'
              value={toolInput}
              onChange={e => setToolInput(e.target.value)}
              className='font-mono text-xs'
              rows={4}
            />
          </div>
          <Button
            onClick={handleToolTest}
            disabled={!sigmaInstance || !toolName || toolTesting}
            size='sm'
            variant='outline'
          >
            {toolTesting ? <Spinner size='small' /> : 'Test Tool'}
          </Button>
          <details className='text-xs'>
            <summary className='cursor-pointer text-yellow-700'>Available Tools</summary>
            <div className='mt-1 max-h-32 overflow-y-auto rounded bg-white p-2 font-mono text-[10px]'>
              {Object.keys(KG_TOOLS).join(', ')}
            </div>
          </details>
        </div>
      </div>
    </ScrollArea>
  );
}
