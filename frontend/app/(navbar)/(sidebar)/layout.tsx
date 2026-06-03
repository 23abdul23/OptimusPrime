import Link from 'next/link';
import { getStartedLinks } from '@/lib/data';

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className='container mx-auto'>
      <div className='flex flex-col gap-4 md:flex-row'>
        <div className='flex w-full flex-col gap-4'>
          <div className='container'>{children}</div>
        </div>
      </div>
    </div>
  );
}
