'use client';

import { ArrowRightIcon, DatabaseIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * KnowledgeGraphTab - Entry point for the live knowledge graph explorer.
 */
export function KnowledgeGraphTab() {
  const router = useRouter();

  return (
    <div className='space-y-6'>
      <div className='rounded-lg border border-sky-100 bg-white p-6 shadow-md'>
        <div className='flex flex-col gap-4 md:flex-row md:items-center md:justify-between'>
          <div>
            <h3 className='flex items-center gap-2 font-semibold text-lg text-sky-900'>
              <DatabaseIcon className='size-5' />
              Open Knowledge Graph Explorer
            </h3>
            <p className='mt-1 text-gray-600 text-sm'>
              Open the live knowledge graph workspace directly and explore the loaded OptimusKG data.
            </p>
          </div>
          <Button type='button' onClick={() => router.push('/knowledge-graph')} className='bg-sky-700 hover:bg-sky-800'>
            Open Explorer
            <ArrowRightIcon className='size-4' />
          </Button>
        </div>
      </div>

    </div>
  );
}
