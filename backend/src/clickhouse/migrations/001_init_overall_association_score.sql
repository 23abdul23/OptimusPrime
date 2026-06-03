-- DO NOT EDIT

CREATE TABLE IF NOT EXISTS overall_association_score (
  gene_id String,
  gene_name String,
  disease_id String,
  score Float32
) ENGINE = MergeTree()
ORDER BY (gene_id, disease_id);
