-- DO NOT EDIT

CREATE TABLE overall_association_score_v2
(
  gene_id LowCardinality(String),
  gene_name LowCardinality(String),
  disease_id LowCardinality(String),
  score Float32
) ENGINE = MergeTree()
ORDER BY (disease_id, gene_id);
