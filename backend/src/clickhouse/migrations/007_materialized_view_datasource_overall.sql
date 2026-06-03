-- DO NOT EDIT

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_datasource_association_score_overall_association_score
ENGINE = MergeTree()
ORDER BY (disease_id, gene_id)
POPULATE
AS
SELECT
  das.gene_id,
  das.gene_name,
  das.disease_id,
  das.datasource_id,
  das.score AS datasource_score,
  oas.score AS overall_score
FROM datasource_association_score das
JOIN overall_association_score oas
  ON das.gene_id = oas.gene_id AND das.disease_id = oas.disease_id;