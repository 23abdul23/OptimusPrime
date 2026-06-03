-- DO NOT EDIT

INSERT INTO target_prioritization_factors_v2 (gene_id, property_name, score)
SELECT
    gene_id,
    property_name,
    score
FROM target_prioritization_factors
ARRAY JOIN
    [
        'Membrane protein', 'Secreted protein', 'Known safety events', 
        'Predicted pockets', 'Ligand binder', 'Small molecule binder',
        'Genetic constraint', 'Paralogues', 'Mouse ortholog identity',
        'Cancer driver gene', 'Gene essentiality', 'Mouse models',
        'Chemical probes', 'Target in clinic', 'Tissue specificity',
        'Tissue distribution'
    ] AS property_name,
    [
        `Membrane protein`, `Secreted protein`, `Known safety events`,
        `Predicted pockets`, `Ligand binder`, `Small molecule binder`,
        `Genetic constraint`, `Paralogues`, `Mouse ortholog identity`,
        `Cancer driver gene`, `Gene essentiality`, `Mouse models`,
        `Chemical probes`, `Target in clinic`, `Tissue specificity`,
        `Tissue distribution`
    ] AS score
WHERE score IS NOT NULL;

DROP TABLE IF EXISTS target_prioritization_factors;

RENAME TABLE target_prioritization_factors_v2 TO target_prioritization_factors;