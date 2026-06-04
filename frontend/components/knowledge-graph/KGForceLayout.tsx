'use client';
import { useSigma } from '@react-sigma/core';
import type EventEmitter from 'events';
import { useCallback, useEffect, useRef } from 'react';
import { useKGStore } from '@/lib/hooks';
import type { EdgeAttributes, NodeAttributes } from '@/lib/interface';
import { focusOptimusNodes, resetOptimusViewport } from '@/lib/optimuskg';

export function KGForceLayout() {
  const sigma = useSigma<NodeAttributes, EdgeAttributes>();
  const workerRef = useRef<Worker | null>(null);
  const settings = useKGStore(state => state.forceSettings);
  const defaultNodeSize = useKGStore(state => state.defaultNodeSize);
  const tickCountRef = useRef(0);
  const recenterTimeoutRef = useRef<number | null>(null);

  const handleWorkerMessage = useCallback(
    (event: MessageEvent) => {
      const { type, positions } = event.data;
      const graph = sigma.getGraph();
      if (!graph) return;

      if (type === 'tick' && positions) {
        for (const { ID, x, y } of positions) {
          graph.setNodeAttribute(ID, 'x', x);
          graph.setNodeAttribute(ID, 'y', y);
        }

        tickCountRef.current += 1;
        if (tickCountRef.current % 4 === 0) {
          sigma.refresh();
        }

        if (recenterTimeoutRef.current) {
          window.clearTimeout(recenterTimeoutRef.current);
        }
        recenterTimeoutRef.current = window.setTimeout(() => {
          resetOptimusViewport(sigma);
        }, 220);
      }

      if (type === 'end') {
        sigma.refresh();
        resetOptimusViewport(sigma);
      }
    },
    [sigma],
  );

  // Initialize worker and simulation
  // biome-ignore lint/correctness/useExhaustiveDependencies: not needed
  useEffect(() => {
    const handleLoaded = () => {
      const graph = sigma.getGraph();
      tickCountRef.current = 0;

      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }

      // Create worker
      workerRef.current = new Worker(new URL('../../lib/force-layout.worker.ts', import.meta.url), { type: 'module' });

      workerRef.current.onmessage = handleWorkerMessage;

      // Prepare data for worker
      const nodes = graph.mapNodes(node => ({ ID: node }));
      const edges = graph.mapEdges((_edge, _attr, source, target) => ({
        source,
        target,
      }));

      // Initialize simulation in worker
      workerRef.current.postMessage({
        type: 'init',
        nodes,
        edges,
        settings: {
          linkDistance: settings.linkDistance,
          chargeStrength: -200,
          collideRadius: defaultNodeSize * 8,
        },
      });

      // Update store with worker controls
      useKGStore.setState({
        forceWorker: {
          start() {
            workerRef.current?.postMessage({ type: 'start' });
          },
          stop() {
            workerRef.current?.postMessage({ type: 'stop' });
          },
        },
      });
      window.setTimeout(() => {
        resetOptimusViewport(sigma);
      }, 80);
    };

    (sigma as EventEmitter).on('loaded', handleLoaded);

    // Cleanup
    return () => {
      (sigma as EventEmitter).off('loaded', handleLoaded);
      if (recenterTimeoutRef.current) {
        window.clearTimeout(recenterTimeoutRef.current);
        recenterTimeoutRef.current = null;
      }
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [sigma, handleWorkerMessage]);

  // Update settings
  // biome-ignore lint/correctness/useExhaustiveDependencies: not needed
  useEffect(() => {
    if (!workerRef.current) return;

    workerRef.current.postMessage({
      type: 'updateSettings',
      settings: {
        linkDistance: settings.linkDistance,
        chargeStrength: -200,
        collideRadius: defaultNodeSize * 8,
      },
    });
  }, [settings]);

  return null;
}
