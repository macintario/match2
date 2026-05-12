/**
 * schoolIndexBuilder.js
 *
 * Builds and manages per-school RAG (Retrieval-Augmented Generation) indexes.
 *
 * An index for a school is a collection of text chunks derived from its DB data,
 * each embedded as a vector. At query time the most semantically relevant chunks
 * are retrieved and passed as context to the LLM.
 *
 * Persistence: indexes are stored in <project-root>/data/vector-indexes/<schoolKey>.json
 * Memory cache: loaded indexes are kept in-process until invalidated.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { VectorIndex } = require('./vectorIndex');
const {
  User,
  XmlUpload,
  TeacherImport,
  PositionImport,
  HistoricalSubjectImport,
  RuaaScheduleImport,
  MxgScheduleImport,
  SubstitutionProposal,
  Categ,
} = require('../models');
const { RAG_EXCEL_COLUMN_MAPPINGS } = require('../config/ragMetadataCatalog');

const DATA_DIR = path.join(__dirname, '../../data/vector-indexes');
const SCHEMA_MODELS = [
  User,
  XmlUpload,
  TeacherImport,
  PositionImport,
  HistoricalSubjectImport,
  RuaaScheduleImport,
  MxgScheduleImport,
  SubstitutionProposal,
  Categ,
];

// ─── Batch sizes para indexación (configurable vía .env) ───────────────────
// Tamaño mayor = menos chunks = menos embeddings = más rápido
// Pero chunks más grandes pueden perder granularidad en búsqueda semántica
const BATCH_SIZE_PXP = Math.max(5, parseInt(process.env.RAG_BATCH_SIZE_PXP || '15', 10));
const BATCH_SIZE_MXG = Math.max(5, parseInt(process.env.RAG_BATCH_SIZE_MXG || '15', 10));
const BATCH_SIZE_HISTORICO = Math.max(5, parseInt(process.env.RAG_BATCH_SIZE_HISTORICO || '50', 10));
const BATCH_SIZE_RUAA = Math.max(5, parseInt(process.env.RAG_BATCH_SIZE_RUAA || '50', 10));
const BATCH_SIZE_CATEG = Math.max(5, parseInt(process.env.RAG_BATCH_SIZE_CATEG || '20', 10));

// In-process LRU-lite cache: schoolKey -> VectorIndex
const indexCache = new Map();

// ─── helpers ─────────────────────────────────────────────────────────────────

function indexFilePath(schoolKey) {
  // Sanitize key so it is safe as a filename
  const safe = schoolKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, `${safe}.json`);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function resolveModelTableName(model) {
  const tableName = typeof model.getTableName === 'function' ? model.getTableName() : model.tableName;
  if (typeof tableName === 'string') return tableName;
  if (tableName && typeof tableName.tableName === 'string') return tableName.tableName;
  return model.name || 'tabla_desconocida';
}

function resolveAttributeTypeLabel(def) {
  const type = def && def.type ? def.type : null;
  if (!type) return 'UNKNOWN';

  const key = String(type.key || '').toUpperCase();
  if (key === 'ENUM') {
    const values = Array.isArray(type.values) ? type.values : [];
    return values.length ? `ENUM(${values.join('|')})` : 'ENUM';
  }

  if (key) {
    const parts = [];
    if (Number.isFinite(type._length)) parts.push(String(type._length));
    if (Number.isFinite(type._precision)) parts.push(String(type._precision));
    if (Number.isFinite(type._scale)) parts.push(String(type._scale));
    return parts.length ? `${key}(${parts.join(',')})` : key;
  }

  return type.constructor && type.constructor.name ? type.constructor.name : 'UNKNOWN';
}

function resolveModelColumnDocs(model) {
  const rawAttributes = model.rawAttributes || {};
  return Object.entries(rawAttributes).map(([attributeName, def]) => {
    const columnName = def.field || attributeName;
    const type = resolveAttributeTypeLabel(def);
    const flags = [];
    if (def.primaryKey) flags.push('PK');
    if (def.allowNull === false) flags.push('NOT NULL');
    if (def.autoIncrement) flags.push('AUTOINCREMENT');
    if (def.references) {
      const target =
        (typeof def.references.model === 'string' && def.references.model) ||
        (def.references.model && def.references.model.tableName) ||
        'tabla';
      const key = def.references.key || 'id';
      flags.push(`FK->${target}.${key}`);
    }

    const attrSuffix = attributeName !== columnName ? ` (attr:${attributeName})` : '';
    const flagSuffix = flags.length ? ` [${flags.join(', ')}]` : '';
    return `${columnName}${attrSuffix}: ${type}${flagSuffix}`;
  });
}

function isSensitiveFieldName(fieldName) {
  const normalized = String(fieldName || '').toLowerCase();
  return (
    normalized.includes('password') ||
    normalized.includes('passwd') ||
    normalized.includes('secret') ||
    normalized.includes('token') ||
    normalized.includes('salt')
  );
}

function resolveSampleAttributes(model, maxColumns = 8) {
  const rawAttributes = model.rawAttributes || {};
  const preferred = ['id', 'uploadId', 'numEmp', 'rfc', 'nombre', 'plantelId', 'plantelDesc', 'createdAt'];

  const validPreferred = preferred.filter((key) => rawAttributes[key] && !isSensitiveFieldName(key));
  const rest = Object.keys(rawAttributes).filter(
    (key) => !validPreferred.includes(key) && !isSensitiveFieldName(key)
  );

  return [...validPreferred, ...rest].slice(0, maxColumns);
}

function serializeSampleRow(row) {
  const clean = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (value === null || value === undefined || value === '') continue;
    if (value instanceof Date) {
      clean[key] = value.toISOString();
      continue;
    }
    const text = typeof value === 'string' ? value : String(value);
    clean[key] = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }
  return JSON.stringify(clean);
}

async function buildDatabaseSchemaChunks() {
  const chunks = [];
  for (const model of SCHEMA_MODELS) {
    const tableName = resolveModelTableName(model);
    const columns = resolveModelColumnDocs(model);
    let totalRows = null;

    try {
      totalRows = await model.count();
    } catch (_) {
      totalRows = null;
    }

    const countText = Number.isFinite(totalRows)
      ? `Registros actuales aproximados: ${totalRows}.`
      : 'Registros actuales aproximados: no disponible.';

    const modelSummary = [
      `Esquema de tabla "${tableName}" (modelo ${model.name}):`,
      countText,
      `Total de columnas: ${columns.length}.`,
    ].join(' ');
    chunks.push({
      id: `schema_${tableName}_summary`,
      text: modelSummary,
      metadata: { type: 'db_schema_summary', table: tableName, model: model.name },
    });

    const columnBatches = chunkArray(columns, 12);
    for (let i = 0; i < columnBatches.length; i += 1) {
      chunks.push({
        id: `schema_${tableName}_cols_${i}`,
        text:
          `Columnas de la tabla "${tableName}" (bloque ${i + 1}/${columnBatches.length}): ` +
          columnBatches[i].join('; '),
        metadata: { type: 'db_schema_columns', table: tableName, model: model.name },
      });
    }
  }

  return chunks;
}

async function buildDatabaseRowSampleChunks(sampleSize = 5) {
  const chunks = [];
  for (const model of SCHEMA_MODELS) {
    const tableName = resolveModelTableName(model);
    const attributes = resolveSampleAttributes(model);

    if (attributes.length === 0) {
      continue;
    }

    let rows = [];
    try {
      rows = await model.findAll({
        attributes,
        order: [['id', 'DESC']],
        limit: sampleSize,
        raw: true,
      });
    } catch (_) {
      try {
        rows = await model.findAll({
          attributes,
          limit: sampleSize,
          raw: true,
        });
      } catch (_) {
        rows = [];
      }
    }

    if (!rows.length) {
      continue;
    }

    const sampleText = rows.map((row, idx) => `fila ${idx + 1}: ${serializeSampleRow(row)}`).join('; ');

    chunks.push({
      id: `schema_${tableName}_rows_sample`,
      text:
        `Muestra de datos reales de la tabla "${tableName}" ` +
        `(hasta ${sampleSize} filas recientes, campos no sensibles): ${sampleText}`,
      metadata: { type: 'db_table_samples', table: tableName, model: model.name, sampleSize: rows.length },
    });
  }

  return chunks;
}

function relationCardinalityLabel(associationType) {
  if (associationType === 'HasMany') return '1:N';
  if (associationType === 'BelongsTo') return 'N:1';
  if (associationType === 'HasOne') return '1:1';
  if (associationType === 'BelongsToMany') return 'N:M';
  return associationType || 'desconocida';
}

function resolveAssociationForeignKey(association) {
  const fk = association && association.foreignKey;
  if (typeof fk === 'string') return fk;
  if (fk && typeof fk === 'object' && typeof fk.name === 'string') return fk.name;
  return association && association.identifierField ? association.identifierField : 'no_especificada';
}

function buildDatabaseRelationshipChunks() {
  const chunks = [];
  const seen = new Set();

  for (const sourceModel of SCHEMA_MODELS) {
    const sourceTable = resolveModelTableName(sourceModel);
    const associations = Object.values(sourceModel.associations || {});

    for (const association of associations) {
      const targetModel = association.target;
      const targetTable = targetModel ? resolveModelTableName(targetModel) : 'tabla_desconocida';
      const foreignKey = resolveAssociationForeignKey(association);
      const associationType = association.associationType || 'desconocida';
      const asAlias = association.as || 'sin_alias';
      const relationKey = `${sourceTable}|${targetTable}|${associationType}|${foreignKey}|${asAlias}`;

      if (seen.has(relationKey)) {
        continue;
      }
      seen.add(relationKey);

      const text = [
        `Relacion entre tablas: ${sourceTable} -> ${targetTable}.`,
        `Tipo de asociacion Sequelize: ${associationType} (cardinalidad ${relationCardinalityLabel(associationType)}).`,
        `Llave de relacion (FK): ${foreignKey}.`,
        `Alias de la relacion: ${asAlias}.`,
        `Uso sugerido: unir ${sourceTable}.${foreignKey} con ${targetTable}.id cuando aplique.`,
      ].join(' ');

      chunks.push({
        id: `relation_${sourceTable}_${targetTable}_${foreignKey}_${chunks.length}`,
        text,
        metadata: {
          type: 'db_relationship',
          sourceTable,
          targetTable,
          associationType,
          cardinality: relationCardinalityLabel(associationType),
          foreignKey,
          alias: asAlias,
        },
      });
    }
  }

  return chunks;
}

function buildExcelMappingChunks() {
  const chunks = [];

  for (const sourceConfig of RAG_EXCEL_COLUMN_MAPPINGS) {
    const { source, description, mappings = [] } = sourceConfig;
    if (!mappings.length) {
      continue;
    }

    chunks.push({
      id: `excel_map_${source}_summary`,
      text: [
        `Diccionario de columnas para origen ${source}.`,
        description || 'Mapeo de columnas del archivo origen a modelos y tablas.',
        `Total de mapeos: ${mappings.length}.`,
      ].join(' '),
      metadata: { type: 'excel_mapping_summary', source, mappings: mappings.length },
    });

    const batches = chunkArray(mappings, 8);
    for (let i = 0; i < batches.length; i += 1) {
      const entries = batches[i]
        .map((item) => {
          const aliases = Array.isArray(item.aliases) && item.aliases.length ? ` aliases:[${item.aliases.join(', ')}]` : '';
          return [
            `excel:${item.excelColumn}${aliases}`,
            `-> ${item.targetTable}.${item.targetColumn}`,
            `(modelo ${item.targetModel})`,
            `significado:${item.meaning}`,
          ].join(' ');
        })
        .join('; ');

      chunks.push({
        id: `excel_map_${source}_${i}`,
        text: `Mapeos de columnas ${source} (bloque ${i + 1}/${batches.length}): ${entries}`,
        metadata: { type: 'excel_mapping', source, block: i + 1, totalBlocks: batches.length },
      });
    }
  }

  return chunks;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Build a VectorIndex from school data that has already been fetched from the DB.
 *
 * @param {object} schoolDataContext  Result of buildAiSchoolDataContext()
 * @param {object} rawRows            Raw DB rows: { pxpRows, mxgRows, historicoRows, ruaaRows }
 * @param {object} options            Optional: { onProgress }
 * @returns {Promise<VectorIndex>}
 */
async function buildSchoolIndex(schoolDataContext, rawRows, options = {}) {
  const index = new VectorIndex();
  const { schoolLabel, pxp, mxg, historico, ruaa } = schoolDataContext;
  const { pxpRows = [], mxgRows = [], historicoRows = [], ruaaRows = [], categRows = [] } = rawRows;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const progress = {
    stage: 'preparing',
    message: 'Preparando índice...',
    totalChunks: 0,
    completedChunks: 0,
  };

  function emitProgress() {
    if (!onProgress) return;
    const percent = progress.totalChunks > 0
      ? Math.min(100, Math.round((progress.completedChunks * 100) / progress.totalChunks))
      : 0;
    onProgress({
      stage: progress.stage,
      message: progress.message,
      totalChunks: progress.totalChunks,
      completedChunks: progress.completedChunks,
      percent,
    });
  }

  function setStage(stage, message) {
    progress.stage = stage;
    progress.message = message;
    emitProgress();
  }

  function planChunks(count) {
    if (!Number.isFinite(count) || count <= 0) return;
    progress.totalChunks += count;
    emitProgress();
  }

  async function addChunkWithProgress(id, text, metadata) {
    await index.add(id, text, metadata);
    progress.completedChunks += 1;
    emitProgress();
  }

  // Build CLAVE → { CATEGORIA, CAT_SIMPLE } lookup from CATALOGO_CATEGORIAS
  const categByClave = new Map();
  for (const c of categRows) {
    const clave = String(c.CLAVE || '').trim().toUpperCase();
    if (clave) categByClave.set(clave, { categoria: c.CATEGORIA || clave, catSimple: c.CAT_SIMPLE || '' });
  }

  // ── Chunks de esquema BD (globales) ───────────────────────────────────────
  setStage('schema', 'Generando esquema de base de datos...');
  const schemaChunks = await buildDatabaseSchemaChunks();
  planChunks(schemaChunks.length);
  setStage('embedding_schema', 'Indexando esquema de base de datos...');
  for (const chunk of schemaChunks) {
    await addChunkWithProgress(chunk.id, chunk.text, chunk.metadata);
  }

  // ── Chunks de relaciones BD (globales) ───────────────────────────────────
  setStage('relationships', 'Generando relaciones de base de datos...');
  const relationshipChunks = buildDatabaseRelationshipChunks();
  planChunks(relationshipChunks.length);
  setStage('embedding_relationships', 'Indexando relaciones de base de datos...');
  for (const chunk of relationshipChunks) {
    await addChunkWithProgress(chunk.id, chunk.text, chunk.metadata);
  }

  // ── Chunks de mapeo Excel -> BD (globales) ───────────────────────────────
  setStage('excel_mapping', 'Generando mapeo Excel -> base de datos...');
  const excelMappingChunks = buildExcelMappingChunks();
  planChunks(excelMappingChunks.length);
  setStage('embedding_excel_mapping', 'Indexando mapeo Excel -> base de datos...');
  for (const chunk of excelMappingChunks) {
    await addChunkWithProgress(chunk.id, chunk.text, chunk.metadata);
  }

  // ── Chunks de muestra de filas por tabla (globales) ──────────────────────
  setStage('table_samples', 'Obteniendo muestras de tablas...');
  const sampleChunks = await buildDatabaseRowSampleChunks(5);
  planChunks(sampleChunks.length);
  setStage('embedding_table_samples', 'Indexando muestras de tablas...');
  for (const chunk of sampleChunks) {
    await addChunkWithProgress(chunk.id, chunk.text, chunk.metadata);
  }

  // ── Chunk 1: Summary (always present) ─────────────────────────────────────
  const summary = [
    `Resumen de la escuela "${schoolLabel}":`,
    `PxP: ${pxp.totalDocentesUnicos} docentes únicos (${pxp.totalRegistros} registros totales).`,
    `MXG: ${mxg.totalDocentesUnicos} docentes únicos con carga, ${mxg.totalTecnicosDocentesConCarga} técnicos docentes.`,
    `Histórico: ${historico.totalDocentesUnicos} docentes únicos.`,
    `RUAA: ${ruaa.totalDocentesUnicos} docentes únicos.`,
  ].join(' ');
  planChunks(1);
  setStage('summary', 'Generando resumen escolar...');
  await addChunkWithProgress('summary', summary, { type: 'summary', school: schoolLabel });

  // ── PxP docentes ──────────────────────────────────────────────────────────────────
  if (pxpRows.length > 0) {
    const batches = chunkArray(pxpRows, BATCH_SIZE_PXP);
    planChunks(batches.length);
    setStage('pxp', 'Indexando docentes PxP...');
    for (let i = 0; i < batches.length; i++) {
      const text =
        `Docentes PxP en "${schoolLabel}" (grupo ${i + 1}/${batches.length}): ` +
        batches[i]
          .map((r) => `${r.nombre} RFC:${r.rfc} Dictamen:${r.dictamen}${r.funciones ? ' Funcion:' + r.funciones : ''}`)
          .join('; ');
      await addChunkWithProgress(`pxp_${i}`, text, { type: 'pxp', school: schoolLabel });
    }

    // ── Chunk resumen de funciones únicas en PxP ───────────────────────────
    const uniqueFunciones = [...new Set(
      pxpRows.map((r) => r.funciones).filter(Boolean)
    )].sort();
    if (uniqueFunciones.length > 0) {
      planChunks(1);
      setStage('pxp_funciones', 'Indexando funciones de PxP...');
      const funcionesText =
        `Funciones (campo FUNCION) registradas en el archivo PxP para "${schoolLabel}": ` +
        uniqueFunciones.join(', ') + '. ' +
        `Total de docentes en PxP: ${pxpRows.length}.`;
      await addChunkWithProgress('pxp_funciones_summary', funcionesText, {
        type: 'pxp_funciones',
        school: schoolLabel,
      });
    }

    // ── Chunk distribución por categoría dictaminada (DICTAMEN × CATALOGO_CATEGORIAS) ──
    const dictamenCount = new Map(); // clave → count
    for (const r of pxpRows) {
      const clave = String(r.dictamen || '').trim().toUpperCase();
      if (clave) dictamenCount.set(clave, (dictamenCount.get(clave) || 0) + 1);
    }
    if (dictamenCount.size > 0) {
      planChunks(1);
      setStage('pxp_dictamen', 'Indexando distribución por categoría dictaminada...');
      const lines = [...dictamenCount.entries()]
        .sort((a, b) => b[1] - a[1]) // mayor a menor
        .map(([clave, count]) => {
          const info = categByClave.get(clave);
          const nombre = info ? info.categoria : clave;
          const simple = info && info.catSimple ? ` (simplificada: "${info.catSimple}")` : '';
          return `${nombre} (CLAVE DICTAMEN: ${clave})${simple}: ${count} docente${count !== 1 ? 's' : ''}`;
        });
      const distText =
        `Distribución de docentes PxP en "${schoolLabel}" por categoría dictaminada ` +
        `(relación campo DICTAMEN de PxP con columna CLAVE de tabla CATALOGO_CATEGORIAS): ` +
        lines.join('; ') + `. Total: ${pxpRows.length} docentes.`;
      await addChunkWithProgress('pxp_dictamen_distribution', distText, {
        type: 'pxp_dictamen',
        school: schoolLabel,
      });
    }

    // ── Chunk catálogo completo de categorías (CATALOGO_CATEGORIAS) ────────
    if (categRows.length > 0) {
      const catBatches = chunkArray(categRows, BATCH_SIZE_CATEG);
      planChunks(catBatches.length);
      setStage('categ_catalog', 'Indexando catálogo de categorías...');
      for (let i = 0; i < catBatches.length; i++) {
        const catText =
          `Catálogo de categorías docentes (CATALOGO_CATEGORIAS) ` +
          `(bloque ${i + 1}/${catBatches.length}): ` +
          catBatches[i]
            .map((c) => {
              const simple = c.CAT_SIMPLE ? ` / simplificada: "${c.CAT_SIMPLE}"` : '';
              return `CLAVE:"${c.CLAVE}" CATEGORIA:"${c.CATEGORIA}"${simple}`;
            })
            .join('; ');
        await addChunkWithProgress(`categ_catalog_${i}`, catText, {
          type: 'categ_catalog',
          school: schoolLabel,
        });
      }
    }
  }

  // ── MXG docentes con carga ────────────────────────────────────────────────────
  if (mxgRows.length > 0) {
    const batches = chunkArray(mxgRows, BATCH_SIZE_MXG);
    planChunks(batches.length);
    setStage('mxg', 'Indexando carga MXG...');
    for (let i = 0; i < batches.length; i++) {
      const text =
        `Docentes con carga en MXG para "${schoolLabel}" (grupo ${i + 1}/${batches.length}): ` +
        batches[i]
          .map(
            (r) =>
              `${r.nombre} RFC:${r.rfc} Plaza:${r.plaza} HrsFTG:${r.hrsFtg} HrsNecesarias:${r.hrsNecesarias}`
          )
          .join('; ');
      await addChunkWithProgress(`mxg_${i}`, text, { type: 'mxg', school: schoolLabel });
    }
  }

  // ── Histórico ──────────────────────────────────────────────────────────────────
  if (historicoRows.length > 0) {
    const batches = chunkArray(historicoRows, BATCH_SIZE_HISTORICO);
    planChunks(batches.length);
    setStage('historico', 'Indexando histórico...');
    for (let i = 0; i < batches.length; i++) {
      const text =
        `Docentes en Histórico para "${schoolLabel}" (grupo ${i + 1}/${batches.length}): ` +
        batches[i].map((r) => `${r.nombre} RFC:${r.rfc}`).join('; ');
      await addChunkWithProgress(`hist_${i}`, text, { type: 'historico', school: schoolLabel });
    }
  }

  // ── RUAA ───────────────────────────────────────────────────────────────────────
  if (ruaaRows.length > 0) {
    const batches = chunkArray(ruaaRows, BATCH_SIZE_RUAA);
    planChunks(batches.length);
    setStage('ruaa', 'Indexando RUAA...');
    for (let i = 0; i < batches.length; i++) {
      const text =
        `Docentes en RUAA para "${schoolLabel}" (grupo ${i + 1}/${batches.length}): ` +
        batches[i].map((r) => `${r.nombre} RFC:${r.rfc}`).join('; ');
      await addChunkWithProgress(`ruaa_${i}`, text, { type: 'ruaa', school: schoolLabel });
    }
  }

  progress.completedChunks = Math.max(progress.completedChunks, progress.totalChunks);
  setStage('done', 'Índice terminado.');

  return index;
}

/**
 * Load a persisted index for a school key (from disk, then memory cache).
 * Returns null if no index has been built yet.
 *
 * @param {string} schoolKey
 * @returns {VectorIndex|null}
 */
function loadIndex(schoolKey) {
  if (indexCache.has(schoolKey)) return indexCache.get(schoolKey);

  const filePath = indexFilePath(schoolKey);
  const index = new VectorIndex();
  if (index.load(filePath)) {
    indexCache.set(schoolKey, index);
    return index;
  }
  return null;
}

/**
 * Persist a built index to disk and update the in-process cache.
 *
 * @param {string} schoolKey
 * @param {VectorIndex} index
 */
function saveIndex(schoolKey, index) {
  index.save(indexFilePath(schoolKey));
  indexCache.set(schoolKey, index);
}

/**
 * Remove a school's index from disk and memory so it will be rebuilt on
 * the next request. Call this after new data is uploaded for a school.
 *
 * @param {string} schoolKey
 */
function invalidateIndex(schoolKey) {
  indexCache.delete(schoolKey);
  const filePath = indexFilePath(schoolKey);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Return the list of school keys that currently have a persisted index.
 * @returns {string[]}
 */
function listIndexedSchools() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

module.exports = {
  buildSchoolIndex,
  loadIndex,
  saveIndex,
  invalidateIndex,
  listIndexedSchools,
};
