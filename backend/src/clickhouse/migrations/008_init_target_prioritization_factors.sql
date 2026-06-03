-- DO NOT EDIT

CREATE TABLE IF NOT EXISTS target_prioritization_factors (
    gene_id String,
    gene_name String,
    `Membrane protein` Float32,
    `Secreted protein` Float32,
    `Known safety events` Float32,
    `Predicted pockets` Float32,
    `Ligand binder` Float32,
    `Small molecule binder` Float32,
    `Genetic constraint` Float32,
    `Paralogues` Float32,
    `Mouse ortholog identity` Float32,
    `Cancer driver gene` Float32,
    `Gene essentiality` Float32,
    `Mouse models` Float32,
    `Chemical probes` Float32,
    `Target in clinic` Float32,
    `Tissue specificity` Float32,
    `Tissue distribution` Float32
) ENGINE = MergeTree()
ORDER BY gene_id;
