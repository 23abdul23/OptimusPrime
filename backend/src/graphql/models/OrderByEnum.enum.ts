import { registerEnumType } from '@nestjs/graphql';

export enum OrderByEnum {
  SCORE = 'score',
  EUROPE_PMC = 'Europe PMC',
  CHEMBL = 'ChEMBL',
  GEL_PANEL_APP = 'GEL PanelApp',
  GWAS_ASSOCIATIONS = 'GWAS Associations',
  IMPC = 'IMPC',
  CANCER_GENE_CENSUS = 'Cancer Gene Census',
  CLINVAR = 'ClinVar',
  INTOGEN = 'IntOGen',
  UNIPROT_CURATED_VARIANTS = 'UniProt curated variants',
  ORPHANET = 'Orphanet',
  UNIPROT_LITERATURE = 'UniProt literature',
  GENE_BURDEN = 'Gene Burden',
  CLINVAR_SOMATIC = 'ClinVar (somatic)',
  GENE2PHENOTYPE = 'Gene2phenotype',
  CLINGEN = 'Clingen',
  REACTOME = 'Reactome',
  EXPRESSION_ATLAS = 'Expression Atlas',
  CRISPR_SCREENS = 'CRISPR Screens',
  GENE_SIGNATURES = 'Gene signatures',
  CANCER_BIOMARKERS = 'Cancer Biomarkers',
  PROJECT_SCORE = 'Project Score',
  SLAPENRICH = 'SLAPenrich',
  PROGENY = 'PROGENy',
}

registerEnumType(OrderByEnum, {
  name: 'OrderByEnum',
  description: 'Available ordering options for target disease association table',
});
