-- DO NOT EDIT

CREATE TABLE IF NOT EXISTS pathway
(
    gene_id LowCardinality(String),
    property_name LowCardinality(String),
    score UInt8
)
ENGINE = MergeTree()
ORDER BY (gene_id, property_name);

CREATE TABLE IF NOT EXISTS druggability
(
    gene_id LowCardinality(String),
    property_name LowCardinality(String),
    score Float32
)
ENGINE = MergeTree()
ORDER BY (gene_id, property_name);

CREATE TABLE IF NOT EXISTS tissue_specificity
(
    gene_id LowCardinality(String),
    property_name LowCardinality(String),
    score Float32
)
ENGINE = MergeTree()
ORDER BY (gene_id, property_name);

CREATE TABLE IF NOT EXISTS differential_expression
(
  gene_id LowCardinality(String),
  disease_id LowCardinality(String),
  property_name LowCardinality(String),
  score Float32
) ENGINE = MergeTree()
ORDER BY (disease_id, gene_id, property_name);

CREATE TABLE IF NOT EXISTS target_prioritization_factors_v2
(
    gene_id LowCardinality(String),
    property_name LowCardinality(String),
    score Float32
)
ENGINE = MergeTree()
ORDER BY (gene_id, property_name);