'use client';

import { Suspense } from 'react';
import AnimatedNetworkBackground from '@/components/AnimatedNetworkBackground';
import { ExploreKGChat } from '@/components/chat/ExploreKGChat';
import { KnowledgeGraphTab } from '@/components/explore';
import { databaseStats } from '@/lib/data';

function ExploreContent() {
  return (
    <div className='relative mx-auto min-h-[30vh] max-w-7xl'>
      <div className='mx-auto h-full min-h-[30vh] p-2 sm:p-6'>
        <div className='relative'>
          <h1 className='text-center font-bold text-3xl sm:text-4xl'>
            Welcome to Optimus Prime
          </h1>

          <p className='mt-3 text-center text-base text-50 sm:text-lg'>
            Knowledge Graph explorer and visualization tool
          </p>

          <div className='mx-auto mt-10 grid max-w-5xl grid-cols-1 gap-4 lg:grid-cols-6'>
            {databaseStats.map((item) => (
              <div key={item.label} className='text-center'>
                <div className='font-bold text-2xl sm:text-3xl'>
                  {item.count}
                </div>
                <div className='text-sm opacity-90'>{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <KnowledgeGraphTab />

      <ExploreKGChat />
    </div>
  );
}

export default function Explore() {
  return (
    <Suspense
      fallback={
        <div className='relative mx-auto min-h-[60vh] max-w-7xl' />
      }
    >
      <ExploreContent />
    </Suspense>
  );
}