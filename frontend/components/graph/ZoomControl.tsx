'use client';

import { useCamera, useSigma } from '@react-sigma/core';
import { fitViewportToNodes } from '@sigma/utils';
import { FocusIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react';

export function ZoomControl() {
  const { zoomIn, zoomOut } = useCamera({ duration: 200, factor: 1.5 });
  const sigma = useSigma();
  const handleReset = () => {
    const visibleNodes = sigma.getGraph().filterNodes((_node, attr) => !attr.hidden);
    if (visibleNodes.length === 0) {
      return;
    }

    fitViewportToNodes(sigma, visibleNodes, { animate: true });
  };

  return (
    <>
      <div className='react-sigma-control'>
        <button type='button' onClick={() => zoomIn()} title='Zoom In'>
          <ZoomInIcon />
        </button>
      </div>
      <div className='react-sigma-control'>
        <button type='button' onClick={() => zoomOut()} title='Zoom Out'>
          <ZoomOutIcon />
        </button>
      </div>
      <div className='react-sigma-control'>
        <button
          type='button'
          onClick={handleReset}
          title='Reset'
        >
          <FocusIcon />
        </button>
      </div>
    </>
  );
}
