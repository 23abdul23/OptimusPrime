-- DO NOT EDIT

CREATE TABLE IF NOT EXISTS datasource_association_score (
    datasource_id LowCardinality(String) NOT NULL,
    disease_id LowCardinality(String) NOT NULL,
    gene_id LowCardinality(String) NOT NULL,
    gene_name LowCardinality(String),
    score Float32 NOT NULL
) ENGINE = MergeTree()
ORDER BY (disease_id, gene_id, datasource_id);
