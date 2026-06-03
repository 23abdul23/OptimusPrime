'use client';

import { useLazyQuery } from '@apollo/client/react';
import { AlertTriangleIcon, CheckCircleIcon, HistoryIcon, InfoIcon, LoaderIcon, UploadIcon, XIcon } from 'lucide-react';
import React, { type ChangeEvent, useId } from 'react';
import { toast } from 'sonner';
import AnimatedNetworkBackground from '@/components/AnimatedNetworkBackground';
import { DiseaseMapCombobox } from '@/components/DiseaseMapCombobox';
import History, { type HistoryItem } from '@/components/History';
import PopUpTable from '@/components/PopUpTable';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { graphConfig } from '@/lib/data';
import { GENE_VERIFICATION_QUERY, TOP_GENES_QUERY } from '@/lib/gql';
import type {
  GeneVerificationData,
  GeneVerificationVariables,
  GetDiseaseData,
  GraphConfigForm,
  TopGeneData,
  TopGeneVariables,
} from '@/lib/interface';
import { distinct, envURL } from '@/lib/utils';

const DEFAULT_AUTOFILL_GENE_LIMIT = 25;

export function SearchTab() {
  const [verifyGenes, { data, loading }] = useLazyQuery<GeneVerificationData, GeneVerificationVariables>(
    GENE_VERIFICATION_QUERY,
  );
  const [fetchTopGenes, { loading: topGenesLoading }] = useLazyQuery<TopGeneData, TopGeneVariables>(TOP_GENES_QUERY);
  const [diseaseData, setDiseaseData] = React.useState<GetDiseaseData | undefined>(undefined);

  React.useEffect(() => {
    (async () => {
      const response = await fetch(`${envURL(process.env.NEXT_PUBLIC_BACKEND_URL)}/diseases`);
      const d = await response.json();
      setDiseaseData(d);
    })();
  }, []);

  const [formData, setFormData] = React.useState<GraphConfigForm>({
    seedGenes: '',
    diseaseMap: 'MONDO_0004976',
    order: '0',
    interactionType: ['PPI'],
    minScore: '0.9',
  });
  const [history, setHistory] = React.useState<HistoryItem[]>([]);
  const [tableOpen, setTableOpen] = React.useState(false);
  const [geneIDs, setGeneIDs] = React.useState<string[]>([]);
  const [showAlert, setShowAlert] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [autofillEnabled, setAutofillEnabled] = React.useState(true);
  const [autofillGeneLimit, setAutofillGeneLimit] = React.useState(DEFAULT_AUTOFILL_GENE_LIMIT);
  const [autofillGeneLimitInput, setAutofillGeneLimitInput] = React.useState<string>(
    String(DEFAULT_AUTOFILL_GENE_LIMIT),
  );
  const [pendingAutofillDiseaseId, setPendingAutofillDiseaseId] = React.useState<string | null>('MONDO_0004976');
  const [uploadedFile, setUploadedFile] = React.useState<File | null>(null);
  const autofillRequestIdRef = React.useRef(0);
  const autofillEnabledRef = React.useRef(true);

  React.useEffect(() => {
    setHistory(JSON.parse(localStorage.getItem('history') ?? '[]'));
    // Dialog handles Escape key internally
  }, []);

  const applyAutofill = React.useCallback(
    async (diseaseId: string) => {
      const requestId = ++autofillRequestIdRef.current;
      try {
        const result = await fetchTopGenes({
          variables: {
            diseaseId,
            limit: autofillGeneLimit,
          },
        });

        if (requestId !== autofillRequestIdRef.current || !autofillEnabledRef.current) {
          return;
        }

        // Extract data from Apollo QueryResult
        const topGeneData = result?.data;
        
        if (!topGeneData?.topGenesByDisease) {
          console.warn('No topGenesByDisease in response:', { topGeneData, result });
          toast.error('No seed genes found for the selected disease', {
            cancel: { label: 'Close', onClick() {} },
          });
          return;
        }

        const genes = topGeneData.topGenesByDisease
          .map(item => item.gene_name)
          .filter((name): name is string => Boolean(name && name.length > 0));

        setFormData(prev => {
          if (prev.diseaseMap !== diseaseId) {
            return prev;
          }

          return {
            ...prev,
            seedGenes: genes.join(', '),
          };
        });
        setUploadedFile(null);

        if (genes.length === 0) {
          console.warn('No valid genes extracted from response:', { topGeneData });
          toast.error('No seed genes found for the selected disease', {
            cancel: { label: 'Close', onClick() {} },
          });
        }
      } catch (error) {
        if (requestId !== autofillRequestIdRef.current || !autofillEnabledRef.current) {
          return;
        }

        console.error('Failed to autofill genes:', error);
        toast.error('Failed to autofill genes from API', {
          cancel: { label: 'Close', onClick() {} },
        });
      }
    },
    [autofillGeneLimit, fetchTopGenes],
  );

  React.useEffect(() => {
    autofillEnabledRef.current = autofillEnabled;

    if (!autofillEnabled) {
      autofillRequestIdRef.current += 1;
      setPendingAutofillDiseaseId(null);
      return;
    }

    // When enabling autofill or when disease changes, request autofill immediately.
    setPendingAutofillDiseaseId(formData.diseaseMap);
  }, [autofillEnabled, formData.diseaseMap]);

  // Debounce the numeric input so rapid typing doesn't trigger re-renders or API requests.
  React.useEffect(() => {
    const t = setTimeout(() => {
      const parsed = Number.parseInt(autofillGeneLimitInput, 10);
      const clamped = Number.isNaN(parsed)
        ? DEFAULT_AUTOFILL_GENE_LIMIT
        : Math.min(1000, Math.max(1, parsed));

      if (clamped !== autofillGeneLimit) {
        setAutofillGeneLimit(clamped);

        // Only trigger autofill when enabled; setPendingAutofillDiseaseId will kick the fetch effect.
        if (autofillEnabled) {
          setPendingAutofillDiseaseId(formData.diseaseMap);
        }
      }
    }, 500);

    return () => clearTimeout(t);
  }, [autofillGeneLimitInput, autofillEnabled, formData.diseaseMap, autofillGeneLimit]);

  React.useEffect(() => {
    if (!autofillEnabled) {
      return;
    }

    setPendingAutofillDiseaseId(formData.diseaseMap);
  }, [autofillEnabled, autofillGeneLimit, formData.diseaseMap]);

  React.useEffect(() => {
    if (!autofillEnabled || !pendingAutofillDiseaseId) {
      return;
    }

    void applyAutofill(pendingAutofillDiseaseId);
    setPendingAutofillDiseaseId(null);
  }, [applyAutofill, autofillEnabled, pendingAutofillDiseaseId]);

  const handleSubmit = async () => {
    const { seedGenes, interactionType } = formData;
    if (interactionType.length === 0) {
      toast.error('Please select at least one interaction type', {
        cancel: { label: 'Close', onClick() {} },
        description: 'Interaction type is required to generate the graph',
      });
      return;
    }
    const ids = distinct(
      seedGenes.split(/[,|\n]/).map(gene =>
        gene
          .trim()
          .replace(/^['"]|['"]$/g, '') // remove surrounding single or double quotes
          .toUpperCase(),
      ),
    ).filter(Boolean);
    if (ids.length === 0) {
      toast.error('Please enter valid seed genes', {
        cancel: { label: 'Close', onClick() {} },
        description: 'Seed genes cannot be empty',
      });
      return;
    }
    setGeneIDs(ids);
    const { error } = await verifyGenes({ variables: { geneIDs: ids } });
    if (error) {
      console.error(error);
      toast.error('Error fetching data', {
        cancel: { label: 'Close', onClick() {} },
        description: 'Server not available,Please try again later',
      });
      return;
    }
    setTableOpen(true);
  };

  const handleSelect = (val: string, key: string) => {
    if (key === 'diseaseMap' && autofillEnabled) {
      setPendingAutofillDiseaseId(val);
    }
    setFormData(prev => ({ ...prev, [key]: val }));
  };

  const handleFileRead = async (event: ChangeEvent<HTMLTextAreaElement>) => {
    setFormData({ ...formData, seedGenes: event.target.value });
  };

  const handleGenerateGraph = (skipWarning = false) => {
    if (!skipWarning) {
      const seedCount = data?.genes.length ?? 0;
      const orderNum = +formData.order;
      const maxGenes = orderNum === 0 ? 5000 : 50;
      const warningThreshold = orderNum === 0 ? 1000 : 25;
      if (seedCount > maxGenes) {
        toast.error('Too many seed genes', {
          description: `Maximum ${maxGenes} genes allowed for ${
            orderNum === 0 ? 'zero' : 'first/second'
          } order networks`,
          cancel: { label: 'Close', onClick() {} },
        });
        return;
      }
      if (seedCount > warningThreshold) {
        setShowAlert(true);
        return;
      }
    }
    const seed = data?.genes.map(gene => gene.ID);
    if (!seed) {
      toast.error('There is no valid gene in the list', {
        cancel: { label: 'Close', onClick() {} },
        description: 'Please enter valid gene names',
      });
      return;
    }
    localStorage.setItem(
      'graphConfig',
      JSON.stringify({
        geneIDs: seed,
        diseaseMap: formData.diseaseMap,
        order: +formData.order,
        interactionType: formData.interactionType,
        minScore: +formData.minScore,
        createdAt: Date.now(),
      }),
    );
    const newHistory = [{ title: `Graph: ${history.length + 1}`, geneIDs: seed, ...formData }, ...history];
    setHistory(newHistory);
    localStorage.setItem('history', JSON.stringify(newHistory));
    setTableOpen(false);
    window.open('/network', '_blank', 'noopener,noreferrer');
  };

  const autoFillToggleId = useId();
  const seedGenesId = useId();
  const seedFileId = useId();

  return (
    <div className='space-y-4 rounded-lg border border-teal-100 bg-white p-4 shadow-xs sm:space-y-5 sm:p-6 sm:py-4'>
      <div className='flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between'>
        <div className='w-1/2 space-y-1'>
          <div className='flex items-end gap-1'>
            <Label htmlFor='diseaseMap'>Disease</Label>
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon size={12} />
              </TooltipTrigger>
              <TooltipContent>
                Contains the disease name to be mapped taken from OpenTargets Portal. <br />
                <b>Note:</b> To search disease using its ID, type disease ID in parentheses.
              </TooltipContent>
            </Tooltip>
          </div>
          <DiseaseMapCombobox
            data={diseaseData}
            value={formData.diseaseMap}
            onChange={val => typeof val === 'string' && handleSelect(val, 'diseaseMap')}
            className='w-full'
          />
        </div>
        <div className='flex flex-col gap-3 sm:flex-row sm:items-center lg:flex-col lg:items-end xl:flex-row xl:items-center'>
          <div className='mr-4 flex flex-col gap-3 sm:flex-row sm:items-center'>
            <div className='flex items-center gap-2'>
              <Label htmlFor={autoFillToggleId} className='whitespace-nowrap text-sm'>
                Autofill Seed Genes
              </Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <InfoIcon size={12} />
                </TooltipTrigger>
                <TooltipContent className='max-w-xs'>
                  <div>
                    <div>Automatically fills the seed genes box with the top 25 genes for the selected disease.</div>
                    <div>Genes are ranked by overall association score from the OpenTargets platform.</div>
                    <div>When enabled, changing the disease refreshes the seed genes automatically.</div>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
            <div className='flex items-center gap-2'>
              <Switch id={autoFillToggleId} checked={autofillEnabled} onCheckedChange={setAutofillEnabled} />
              {/* <span className='text-muted-foreground text-xs sm:text-sm'>
                {topGenesLoading ? `Loading top ${autofillGeneLimit} genes...` : `Top ${autofillGeneLimit} genes`}
              </span> */}
            </div>
            <div className='flex items-center gap-2'>
              <Label htmlFor='autofill-gene-limit' className='whitespace-nowrap text-sm'>
                Limit
              </Label>
              <Input
                id='autofill-gene-limit'
                type='number'
                min={1}
                max={1000}
                step={1}
                className='h-8 w-24'
                value={autofillGeneLimitInput}
                onChange={e => setAutofillGeneLimitInput(e.target.value)}
                onBlur={() => {
                  // Ensure final value is applied immediately on blur
                  const parsed = Number.parseInt(autofillGeneLimitInput, 10);
                  const clamped = Number.isNaN(parsed)
                    ? DEFAULT_AUTOFILL_GENE_LIMIT
                    : Math.min(1000, Math.max(1, parsed));
                  if (clamped !== autofillGeneLimit) {
                    setAutofillGeneLimit(clamped);
                    if (autofillEnabled) setPendingAutofillDiseaseId(formData.diseaseMap);
                  }
                }}
                disabled={topGenesLoading || !autofillEnabled}
              />
            </div>
          </div>

          <Button variant='outline' size='sm' className='h-8 px-3 text-sm' onClick={() => setHistoryOpen(true)}>
            <HistoryIcon size={16} />
            History
          </Button>
        </div>
      </div>
      <div className='flex flex-col lg:flex-row'>
        <div className='flex-1'>
          <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
            <Label htmlFor={seedGenesId} className='font-medium'>
              Seed Genes
            </Label>
            <p className='text-xs text-zinc-500 sm:text-sm'>
              (one-per-line or CSV; examples:
              <button
                type='button'
                className='ml-1 cursor-pointer underline hover:text-zinc-700'
                onClick={() =>
                  setFormData({
                    ...formData,
                    seedGenes: 'MAPT, STX6, EIF2AK3, MOBP, DCTN1, LRRK2',
                  })
                }
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setFormData({
                      ...formData,
                      seedGenes: 'MAPT, STX6, EIF2AK3, MOBP, DCTN1, LRRK2',
                    });
                  }
                }}
              >
                #1
              </button>
              <button
                type='button'
                className='ml-2 cursor-pointer underline hover:text-zinc-700'
                onClick={() =>
                  setFormData({
                    ...formData,
                    seedGenes:
                      'ENSG00000185013\nENSG00000076685\nENSG00000166548\nENSG00000156136\nENSG00000114956\nENSG00000116981',
                  })
                }
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setFormData({
                      ...formData,
                      seedGenes:
                        'ENSG00000185013\nENSG00000076685\nENSG00000166548\nENSG00000156136\nENSG00000114956\nENSG00000116981',
                    });
                  }
                }}
              >
                #2
              </button>
              <button
                type='button'
                className='ml-2 cursor-pointer underline hover:text-zinc-700'
                onClick={() =>
                  setFormData({
                    ...formData,
                    seedGenes: 'NT5C1B\nNT5C2\nTK2\nDCK\nDGUOK\nNT5C1A',
                  })
                }
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setFormData({
                      ...formData,
                      seedGenes: 'NT5C1B\nNT5C2\nTK2\nDCK\nDGUOK\nNT5C1A',
                    });
                  }
                }}
              >
                #3
              </button>
              )
            </p>
          </div>
          <Textarea
            id={seedGenesId}
            placeholder='Type seed genes (comma or newline separated)'
            className='mt-2 h-33'
            value={formData.seedGenes}
            onChange={handleFileRead}
            disabled={topGenesLoading}
            required
          />
        </div>

        <div className='flex flex-row items-center justify-center py-2 lg:flex-col lg:px-4'>
          <div className='h-px w-full bg-slate-800/70 lg:hidden' />
          <div className='hidden w-px flex-1 bg-slate-800/70 lg:block' />
          <span className='px-2 py-1 text-slate-400 text-xs lg:py-2'>OR</span>
          <div className='h-px w-full bg-slate-800/70 lg:hidden' />
          <div className='hidden w-px flex-1 bg-slate-800/70 lg:block' />
        </div>

        <div className='flex-1'>
          <Label htmlFor={seedFileId} className='mb-3 block font-medium text-sm text-teal-900'>
            Upload Text File
          </Label>
          <div className='relative'>
            <Input
              id={seedFileId}
              type='file'
              accept='.txt'
              className='absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0'
              onChange={async e => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f?.type !== 'text/plain') {
                  toast.error('Invalid file type', {
                    cancel: { label: 'Close', onClick() {} },
                  });
                  return;
                }
                const text = await f.text();
                setFormData({ ...formData, seedGenes: text });
                setUploadedFile(f);
              }}
              disabled={topGenesLoading}
            />
            <div
              className={`cursor-pointer rounded-lg border-2 border-dashed p-3 text-center transition-all sm:p-4 ${
                uploadedFile
                  ? 'border-green-300 bg-green-50 hover:bg-green-100'
                  : 'border-gray-200 bg-gray-50 hover:border-gray-300 hover:bg-gray-100'
              }`}
            >
              {uploadedFile ? (
                <div className='flex flex-col items-center justify-center gap-2 p-4 sm:flex-row sm:gap-3 sm:p-6'>
                  <CheckCircleIcon className='size-6 text-green-600 sm:size-8' />
                  <div className='text-center sm:text-left'>
                    <p className='font-medium text-green-800 text-sm'>{uploadedFile.name}</p>
                    <p className='text-green-600 text-xs'>File uploaded successfully</p>
                  </div>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    className='z-10 text-green-600 hover:bg-green-200 hover:text-green-800'
                    onClick={e => {
                      e.stopPropagation();
                      setUploadedFile(null);
                    }}
                  >
                    <XIcon className='size-4' />
                  </Button>
                </div>
              ) : (
                <>
                  <UploadIcon className='mx-auto mb-2 size-8 text-gray-400 sm:mb-3 sm:size-10' />
                  <p className='mb-1 text-gray-600 text-sm'>Browse... No file selected.</p>
                  <p className='text-gray-400 text-xs'>
                    Click to upload or drag and drop your gene list (.txt files only)
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        {graphConfig.map(config => (
          <div key={config.id} className='space-y-1'>
            <div className='flex items-end gap-1'>
              <Label htmlFor={config.id}>{config.name}</Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <InfoIcon size={12} />
                </TooltipTrigger>
                <TooltipContent>{config.tooltipContent}</TooltipContent>
              </Tooltip>
            </div>
            <Select required value={formData[config.id]} onValueChange={val => handleSelect(val, config.id)}>
              <SelectTrigger
                className='bg-accent-foreground hover:bg-accent hover:text-accent-foreground'
                id={config.id}
              >
                <SelectValue placeholder='Select...' />
              </SelectTrigger>
              <SelectContent>
                {config.options.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
      <div className='flex justify-center'>
        <Button
          type='button'
          onClick={handleSubmit}
          className='relative w-full overflow-hidden font-semibold hover:opacity-90 sm:w-3/4 lg:w-1/2'
        >
          {/* Animated background inside the button */}
          <AnimatedNetworkBackground
            className='pointer-events-none absolute inset-0 h-full w-full opacity-40'
            moving={loading}
            speedMultiplier={10}
          />
          <span className='relative z-10 flex items-center justify-center'>
            {loading ? (
              <>
                <LoaderIcon className='mr-2 animate-spin' size={20} />
                <span className='hidden sm:inline'>Checking {geneIDs.length} Genes...</span>
                <span className='sm:hidden'>Checking Genes...</span>
              </>
            ) : (
              'Submit'
            )}
          </span>
        </Button>
      </div>
      <PopUpTable
        setTableOpen={setTableOpen}
        tableOpen={tableOpen}
        handleGenerateGraph={handleGenerateGraph}
        data={data}
        geneIDs={geneIDs}
      />
      <AlertDialog open={showAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className='flex items-center text-red-500'>
              <AlertTriangleIcon size={24} className='mr-2' /> Warning!
            </AlertDialogTitle>
            <AlertDialogDescription className='text-black'>
              You are about to generate a graph with a large number of nodes/edges. This may take a long time to
              complete.
            </AlertDialogDescription>
            <p className='font-semibold text-black'>Are you sure you want to proceed?</p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowAlert(false)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowAlert(false);
                handleGenerateGraph(true);
                document.body.removeAttribute('style');
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <History
        history={history}
        historyOpen={historyOpen}
        setHistoryOpen={setHistoryOpen}
        setHistory={setHistory}
        setFormData={setFormData}
      />
    </div>
  );
}
