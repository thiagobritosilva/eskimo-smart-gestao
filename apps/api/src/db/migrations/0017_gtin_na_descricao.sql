-- =====================================================================
-- ESKIMO SMART GESTÃO — Migration 0017: GTIN que veio no início do nome do produto
-- Motivo: o relatório do PDV exporta o código de barras dentro da descrição ("7898125167608 REV - CASCAO P"),
-- e produtos importados ficaram "sem GTIN". Correção pontual e auditada:
--   só produtos SEM código de barras, cujo nome começa com um GTIN de dígito verificador válido
--   que não pertence a outro produto → grava o GTIN e tira o número do nome.
-- Nenhum estoque, custo, preço ou movimentação é alterado.
-- =====================================================================
CREATE OR REPLACE FUNCTION gtin_valido(g text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s int := 0; i int; n int; d int;
BEGIN
  IF g !~ '^(\d{8}|\d{12,14})$' THEN RETURN false; END IF;
  n := length(g);
  FOR i IN 1..n-1 LOOP
    d := substr(g, n - i, 1)::int;
    s := s + d * CASE WHEN i % 2 = 1 THEN 3 ELSE 1 END;
  END LOOP;
  RETURN (10 - s % 10) % 10 = substr(g, n, 1)::int;
END $$;

WITH cand AS (
  SELECT p.id, p.name, (regexp_match(p.name, '^\s*(\d{8}|\d{12,14})(?:\s*[-–:|]\s*|\s+)(.+)$')) AS m
  FROM products p WHERE p.barcode IS NULL
), ok AS (
  SELECT c.id, c.name AS old_name, c.m[1] AS gtin, trim(c.m[2]) AS new_name,
         row_number() OVER (PARTITION BY c.m[1] ORDER BY c.id) AS rn
  FROM cand c
  WHERE c.m IS NOT NULL AND gtin_valido(c.m[1])
    AND NOT EXISTS (SELECT 1 FROM products o WHERE o.barcode = c.m[1])
), upd AS (
  UPDATE products p SET barcode = ok.gtin, name = ok.new_name
  FROM ok WHERE ok.id = p.id AND ok.rn = 1
  RETURNING p.id, ok.old_name, ok.gtin, ok.new_name
)
INSERT INTO audit_log (actor_type, action, entity, entity_id, before, after, metadata)
SELECT 'system', 'product.updated', 'product', upd.id::text,
       jsonb_build_object('name', upd.old_name, 'barcode', NULL),
       jsonb_build_object('name', upd.new_name, 'barcode', upd.gtin),
       jsonb_build_object('origem', 'migration 0017: GTIN separado do início do nome do produto')
FROM upd;
