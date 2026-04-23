const { XMLValidator } = require('fast-xml-parser');
const { Op, fn, col } = require('sequelize');
const { parsePayrollXml, parseHistoricoXml, parseRuaaXml } = require('../services/payrollXmlParser');
const {
  parsePayrollWorkbook,
  parseHistoricoWorkbook,
  parseRuaaWorkbook,
} = require('../services/payrollWorkbookParser');
const { parseMxgWorkbook } = require('../services/mxgParser');
const { generateSubstitutionProposals } = require('../services/substitutionProposalService');
const {
  XmlUpload,
  TeacherImport,
  PositionImport,
  HistoricalSubjectImport,
  RuaaScheduleImport,
  MxgScheduleImport,
  SubstitutionProposal,
  User,
  sequelize,
} = require('../models');

function setFlash(req, type, text) {
  req.session.flash = { type, text };
}

function decodeXmlBuffer(buffer) {
  const header = buffer.toString('ascii', 0, 300).toLowerCase();
  if (header.includes('encoding="windows-1252"') || header.includes("encoding='windows-1252'")) {
    return buffer.toString('latin1');
  }
  if (header.includes('encoding="iso-8859-1"') || header.includes("encoding='iso-8859-1'")) {
    return buffer.toString('latin1');
  }
  return buffer.toString('utf8');
}

function isAllowedXmlFilename(fileName) {
  return /\.(xml|xls|xlsx)$/i.test(fileName || '');
}

function isXmlFilename(fileName) {
  return /\.xml$/i.test(fileName || '');
}

function isExcelFilename(fileName) {
  return /\.(xls|xlsx)$/i.test(fileName || '');
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

const HEATMAP_START_MINUTES = 7 * 60;
const HEATMAP_END_MINUTES = 22 * 60;
const HEATMAP_SLOT_MINUTES = 30;

function minutesFromTimeToken(token) {
  const value = String(token || '').trim();
  if (!value) {
    return null;
  }

  if (/^\d{1,2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(':').map(Number);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      return h * 60 + m;
    }
    return null;
  }

  if (/^\d{1,2}$/.test(value)) {
    const h = Number(value);
    if (h >= 0 && h < 24) {
      return h * 60;
    }
    return null;
  }

  if (/^\d{3,4}$/.test(value)) {
    const h = Number(value.length === 3 ? value.slice(0, 1) : value.slice(0, 2));
    const m = Number(value.length === 3 ? value.slice(1) : value.slice(2));
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      return h * 60 + m;
    }
  }

  return null;
}

function parseMxgDayRanges(value) {
  const text = String(value || '').trim();
  if (!text) {
    return [];
  }

  const ranges = [];
  const regex = /(\d{1,2}:\d{2}|\d{1,2}|\d{3,4})\s*(?:-|a|al|hasta|–|—)\s*(\d{1,2}:\d{2}|\d{1,2}|\d{3,4})/gi;
  let match = regex.exec(text);
  while (match) {
    const start = minutesFromTimeToken(match[1]);
    const end = minutesFromTimeToken(match[2]);
    if (start !== null && end !== null && end > start) {
      ranges.push({ start, end });
    }
    match = regex.exec(text);
  }

  return ranges;
}

function buildMxgHeatmap(rows) {
  const days = [
    { key: 'lunes', label: 'Lunes' },
    { key: 'martes', label: 'Martes' },
    { key: 'miercoles', label: 'Miercoles' },
    { key: 'jueves', label: 'Jueves' },
    { key: 'viernes', label: 'Viernes' },
    { key: 'sabado', label: 'Sabado' },
  ];

  const slotCount = (HEATMAP_END_MINUTES - HEATMAP_START_MINUTES) / HEATMAP_SLOT_MINUTES;
  const slotLabels = Array.from({ length: slotCount }, (_, idx) => {
    const minutes = HEATMAP_START_MINUTES + idx * HEATMAP_SLOT_MINUTES;
    const h = String(Math.floor(minutes / 60)).padStart(2, '0');
    const m = String(minutes % 60).padStart(2, '0');
    return `${h}:${m}`;
  });

  const slotSetsByDay = days.map(() => Array.from({ length: slotCount }, () => new Set()));

  for (const row of rows) {
    const groupKey = [
      row.plantelId || 'N/A',
      row.carreraId || 'N/A',
      row.grupo || `ROW-${row.id}`,
    ].join('|');

    days.forEach((day, dayIndex) => {
      const ranges = parseMxgDayRanges(row[day.key]);
      for (const range of ranges) {
        for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
          const slotStart = HEATMAP_START_MINUTES + slotIndex * HEATMAP_SLOT_MINUTES;
          const slotEnd = slotStart + HEATMAP_SLOT_MINUTES;
          const overlaps = range.start < slotEnd && slotStart < range.end;
          if (overlaps) {
            slotSetsByDay[dayIndex][slotIndex].add(groupKey);
          }
        }
      }
    });
  }

  const matrix = Array.from({ length: slotCount }, (_, slotIndex) =>
    days.map((_, dayIndex) => slotSetsByDay[dayIndex][slotIndex].size)
  );

  const sabadoIndex = days.findIndex((day) => day.key === 'sabado');
  if (sabadoIndex >= 0) {
    const hasSaturdayUsage = matrix.some((row) => row[sabadoIndex] > 0);
    if (!hasSaturdayUsage) {
      days.splice(sabadoIndex, 1);
      matrix.forEach((row) => row.splice(sabadoIndex, 1));
    }
  }

  const maxCount = matrix.reduce(
    (acc, row) => Math.max(acc, ...row),
    0
  );

  const minCount = matrix.reduce(
    (acc, row) => Math.min(acc, ...row),
    Number.POSITIVE_INFINITY
  );

  return {
    days,
    slotLabels,
    matrix,
    minCount: Number.isFinite(minCount) ? minCount : 0,
    maxCount,
  };
}

async function purgePreviousUploadByType(uploadType, transaction) {
  const previousUploads = await XmlUpload.findAll({
    where: { uploadType },
    attributes: ['id'],
    transaction,
  });

  if (!previousUploads.length) {
    return;
  }

  const uploadIds = previousUploads.map((item) => item.id);

  if (uploadType === 'PXP') {
    await PositionImport.destroy({ where: { uploadId: { [Op.in]: uploadIds } }, transaction });
    await TeacherImport.destroy({ where: { uploadId: { [Op.in]: uploadIds } }, transaction });
  }

  if (uploadType === 'HISTORICO') {
    await HistoricalSubjectImport.destroy({
      where: { uploadId: { [Op.in]: uploadIds } },
      transaction,
    });
  }

  if (uploadType === 'RUAA') {
    await RuaaScheduleImport.destroy({
      where: { uploadId: { [Op.in]: uploadIds } },
      transaction,
    });
  }

  if (uploadType === 'MXG') {
    await MxgScheduleImport.destroy({
      where: { uploadId: { [Op.in]: uploadIds } },
      transaction,
    });
  }

  await XmlUpload.destroy({ where: { id: { [Op.in]: uploadIds } }, transaction });
}

function redirectByRole(req, res) {
  const { role } = req.session.user;

  if (role === 'admin') {
    return res.redirect('/admin');
  }

  if (role === 'analista') {
    return res.redirect('/analista');
  }

  return res.redirect('/escuela');
}

async function analistaDashboard(req, res) {
  const report = req.session.analistaXmlReport || null;
  const historicoReport = req.session.analistaHistoricoReport || null;
  const ruaaReport = req.session.analistaRuaaReport || null;
  const mxgReport = req.session.analistaMxgReport || null;
  const recentUploads = await XmlUpload.findAll({
    order: [['uploadedAt', 'DESC']],
    limit: 20,
    include: [{ model: User, attributes: ['id', 'name', 'username'] }],
  });

  const latestMxgUpload = await XmlUpload.findOne({
    where: { uploadType: 'MXG' },
    order: [['uploadedAt', 'DESC']],
    attributes: ['id'],
  });

  let horasSolicitadasPorAcademia = [];
  let detalleSolicitudesPorAcademia = {};
  let horasSolicitadasTotales = {
    totalSolicitudes: 0,
    totalHorasSolicitadas: 0,
  };
  let escuelaHorasSolicitadas = null;
  if (latestMxgUpload) {
    const anyMxgRow = await MxgScheduleImport.findOne({
      where: { uploadId: latestMxgUpload.id },
      attributes: ['plantelDesc', 'plantelId'],
    });

    if (anyMxgRow) {
      const plantelId = anyMxgRow.get('plantelId');
      const plantelDesc = anyMxgRow.get('plantelDesc');
      escuelaHorasSolicitadas = [plantelId, plantelDesc].filter(Boolean).join(' - ') || null;
    }

    const groupedRows = await MxgScheduleImport.findAll({
      where: {
        uploadId: latestMxgUpload.id,
        needsAdditionalHours: true,
      },
      attributes: [
        'academiaDesc',
        [fn('COUNT', col('id')), 'totalSolicitudes'],
        [fn('SUM', col('hrsNecesarias')), 'totalHorasSolicitadas'],
      ],
      group: ['academiaDesc'],
      order: [[fn('SUM', col('hrsNecesarias')), 'DESC']],
    });

    horasSolicitadasPorAcademia = groupedRows.map((row) => ({
      academiaDesc: row.get('academiaDesc') || 'Sin academia',
      totalSolicitudes: Number(row.get('totalSolicitudes') || 0),
      totalHorasSolicitadas: Number(row.get('totalHorasSolicitadas') || 0),
    }));

    horasSolicitadasTotales = horasSolicitadasPorAcademia.reduce(
      (acc, item) => ({
        totalSolicitudes: acc.totalSolicitudes + item.totalSolicitudes,
        totalHorasSolicitadas: acc.totalHorasSolicitadas + item.totalHorasSolicitadas,
      }),
      { totalSolicitudes: 0, totalHorasSolicitadas: 0 }
    );

    const detalleRows = await MxgScheduleImport.findAll({
      where: {
        uploadId: latestMxgUpload.id,
        needsAdditionalHours: true,
      },
      attributes: ['academiaDesc', 'asignaturaDesc', 'nombre', 'grupo', 'hrsNecesarias'],
      order: [['academiaDesc', 'ASC'], ['asignaturaDesc', 'ASC'], ['nombre', 'ASC']],
    });

    detalleSolicitudesPorAcademia = detalleRows.reduce((acc, row) => {
      const academiaKey = row.get('academiaDesc') || 'Sin academia';
      if (!acc[academiaKey]) {
        acc[academiaKey] = [];
      }

      acc[academiaKey].push({
        asignaturaDesc: row.get('asignaturaDesc') || '-',
        docente: row.get('nombre') || '-',
        grupo: row.get('grupo') || '-',
        horasSolicitadas: Number(row.get('hrsNecesarias') || 0),
      });

      return acc;
    }, {});
  }

  return res.render('dashboard-analista', {
    title: 'Panel Analista',
    report,
    historicoReport,
    ruaaReport,
    mxgReport,
    horasSolicitadasPorAcademia,
    detalleSolicitudesPorAcademia,
    horasSolicitadasTotales,
    escuelaHorasSolicitadas,
    recentUploads,
  });
}

async function analistaAnalyticsPage(req, res) {
  const latestMxgUpload = await XmlUpload.findOne({
    where: { uploadType: 'MXG' },
    order: [['uploadedAt', 'DESC']],
    attributes: ['id'],
  });

  let escuelaHorasSolicitadas = null;
  let mxgHeatmap = null;
  let hrsXCubHistogram = [];

  // Valores seleccionados en los filtros (pueden venir vacíos)
  const filterSemNivel = req.query.semNivel || '';
  const filterAcademia = req.query.academia || '';
  const filterAsigTipo = req.query.asigTipo || '';
  const filterModalidad = req.query.modalidad || '';
  const filterCarreraDesc = req.query.carreraDesc || '';

  // Listas de valores únicos para los <select>
  let semNivelOptions = [];
  let academiaOptions = [];
  let asigTipoOptions = [];
  let modalidadOptions = [];
  let carreraDescOptions = [];
  let hasSemNivelField = false;
  let hasAsigTipoField = false;

  if (latestMxgUpload) {
    const queryInterface = sequelize.getQueryInterface();
    const mxgTableColumns = await queryInterface.describeTable('mxg_schedule_imports').catch(() => ({}));
    hasSemNivelField = Boolean(mxgTableColumns.semNivel);
    hasAsigTipoField = Boolean(mxgTableColumns.asigTipo);

    const anyMxgRow = await MxgScheduleImport.findOne({
      where: { uploadId: latestMxgUpload.id },
      attributes: ['plantelDesc', 'plantelId'],
    });

    if (anyMxgRow) {
      const plantelId = anyMxgRow.get('plantelId');
      const plantelDesc = anyMxgRow.get('plantelDesc');
      escuelaHorasSolicitadas = [plantelId, plantelDesc].filter(Boolean).join(' - ') || null;
    }

    // Obtener valores únicos para los selectores de filtro solo con columnas disponibles.
    const filterAttributes = ['academiaDesc', 'modalidad', 'carreraDesc'];
    if (hasSemNivelField) {
      filterAttributes.push('semNivel');
    }
    if (hasAsigTipoField) {
      filterAttributes.push('asigTipo');
    }

    const mxgRowsForFilters = await MxgScheduleImport.findAll({
      where: { uploadId: latestMxgUpload.id },
      attributes: filterAttributes,
      raw: true,
    });

    semNivelOptions = hasSemNivelField
      ? Array.from(
        new Set(mxgRowsForFilters.map((r) => String(r.semNivel || '').trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }))
      : [];

    academiaOptions = Array.from(
      new Set(mxgRowsForFilters.map((r) => String(r.academiaDesc || '').trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));

    asigTipoOptions = hasAsigTipoField
      ? Array.from(
        new Set(mxgRowsForFilters.map((r) => String(r.asigTipo || '').trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }))
      : [];

    modalidadOptions = Array.from(
      new Set(mxgRowsForFilters.map((r) => String(r.modalidad || '').trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));

    carreraDescOptions = Array.from(
      new Set(mxgRowsForFilters.map((r) => String(r.carreraDesc || '').trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));

    // Construir cláusula WHERE con los filtros activos
    const heatmapWhere = { uploadId: latestMxgUpload.id };
    if (filterSemNivel && hasSemNivelField) heatmapWhere.semNivel = filterSemNivel;
    if (filterAcademia) heatmapWhere.academiaDesc = filterAcademia;
    if (filterAsigTipo && hasAsigTipoField) heatmapWhere.asigTipo = filterAsigTipo;
    if (filterModalidad) heatmapWhere.modalidad = filterModalidad;
    if (filterCarreraDesc) heatmapWhere.carreraDesc = filterCarreraDesc;

    const mxgRowsForHeatmap = await MxgScheduleImport.findAll({
      where: heatmapWhere,
      attributes: ['id', 'plantelId', 'carreraId', 'grupo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
    });

    mxgHeatmap = buildMxgHeatmap(mxgRowsForHeatmap);
  }

  const latestPxpUpload = await XmlUpload.findOne({
    where: { uploadType: 'PXP' },
    order: [['uploadedAt', 'DESC']],
    attributes: ['id'],
  });

  if (latestPxpUpload) {
    const freqRows = await TeacherImport.findAll({
      where: {
        uploadId: latestPxpUpload.id,
        hrsXCub: { [Op.regexp]: '^-?[0-9]+(\\.[0-9]+)?$' },
      },
      attributes: [
        [fn('FLOOR', sequelize.literal('CAST(`hrsXCub` AS SIGNED) / 2')), 'intervaloBase'],
        [fn('COUNT', col('id')), 'cantidad'],
      ],
      group: [fn('FLOOR', sequelize.literal('CAST(`hrsXCub` AS SIGNED) / 2'))],
      order: [[fn('FLOOR', sequelize.literal('CAST(`hrsXCub` AS SIGNED) / 2')), 'ASC']],
    });

    hrsXCubHistogram = freqRows.map((row) => {
      const base = Number(row.get('intervaloBase')) * 2;
      return {
        valor: `${base} a ${base + 1}`,
        base,
        cantidad: Number(row.get('cantidad') || 0),
      };
    });

    const nonNumericCount = await TeacherImport.count({
      where: {
        uploadId: latestPxpUpload.id,
        hrsXCub: { [Op.notRegexp]: '^-?[0-9]+(\\.[0-9]+)?$' },
      },
    });
    if (nonNumericCount > 0) {
      hrsXCubHistogram.push({ valor: '(sin valor)', base: null, cantidad: nonNumericCount });
    }
  }

  return res.render('analista-analitica', {
    title: 'Analitica MXG',
    mxgHeatmap,
    escuelaHorasSolicitadas,
    hrsXCubHistogram,
    semNivelOptions,
    academiaOptions,
    asigTipoOptions,
    modalidadOptions,
    carreraDescOptions,
    filterSemNivel,
    filterAcademia,
    filterAsigTipo,
    filterModalidad,
    filterCarreraDesc,
    hasSemNivelField,
    hasAsigTipoField,
  });
}

async function analistaProposalsPage(req, res) {
  const proposalGenerationReport = req.session.proposalGenerationReport || null;
  delete req.session.proposalGenerationReport;

  const recentProposals = await SubstitutionProposal.findAll({
    order: [['createdAt', 'DESC']],
    limit: 200,
  });

  const proposalSummary = recentProposals.reduce(
    (acc, item) => {
      const assigned = Number(item.assignedHours || 0);
      acc.totalPropuestas += 1;
      acc.totalHorasAsignadas += assigned;
      if (item.hasTurnoConflict) {
        acc.conflictosTurno += 1;
      }
      if (item.hasHorarioConflict) {
        acc.conflictosHorario += 1;
      }
      if (item.proposalStatus === 'ACEPTADA') {
        acc.aceptadas += 1;
      } else if (item.proposalStatus === 'RECHAZADA') {
        acc.rechazadas += 1;
      } else {
        acc.pendientes += 1;
      }
      return acc;
    },
    {
      totalPropuestas: 0,
      totalHorasAsignadas: 0,
      conflictosTurno: 0,
      conflictosHorario: 0,
      pendientes: 0,
      aceptadas: 0,
      rechazadas: 0,
    }
  );

  return res.render('analista-propuestas', {
    title: 'Propuestas de Sustitucion',
    recentProposals,
    proposalSummary,
    proposalGenerationReport,
  });
}

async function generateAnalistaSubstitutionProposals(req, res) {
  try {
    const [latestMxgUpload, latestPxpUpload, latestHistoricoUpload, latestRuaaUpload] = await Promise.all([
      XmlUpload.findOne({ where: { uploadType: 'MXG' }, order: [['uploadedAt', 'DESC']], attributes: ['id'] }),
      XmlUpload.findOne({ where: { uploadType: 'PXP' }, order: [['uploadedAt', 'DESC']], attributes: ['id'] }),
      XmlUpload.findOne({ where: { uploadType: 'HISTORICO' }, order: [['uploadedAt', 'DESC']], attributes: ['id'] }),
      XmlUpload.findOne({ where: { uploadType: 'RUAA' }, order: [['uploadedAt', 'DESC']], attributes: ['id'] }),
    ]);

    if (!latestMxgUpload || !latestPxpUpload || !latestHistoricoUpload || !latestRuaaUpload) {
      setFlash(
        req,
        'error',
        'Para generar propuestas necesitas cargar primero MXG, PxP, HISTORICO y RUAA.'
      );
      return res.redirect('/analista/propuestas');
    }

    const [mxgRequests, teachers, historicalRows, ruaaRows] = await Promise.all([
      MxgScheduleImport.findAll({
        where: {
          uploadId: latestMxgUpload.id,
          needsAdditionalHours: true,
          hrsNecesarias: { [Op.gt]: 0 },
        },
      }),
      TeacherImport.findAll({
        where: {
          uploadId: latestPxpUpload.id,
          hrsXCub: { [Op.regexp]: '^-?[0-9]+(\\.[0-9]+)?$' },
        },
      }),
      HistoricalSubjectImport.findAll({ where: { uploadId: latestHistoricoUpload.id } }),
      RuaaScheduleImport.findAll({ where: { uploadId: latestRuaaUpload.id } }),
    ]);

    const eligibleTeachers = teachers.filter((t) => Number(String(t.hrsXCub).replace(',', '.')) > 0);

    const generationResult = generateSubstitutionProposals({
      mxgRequests,
      teachers: eligibleTeachers,
      historicalRows,
      ruaaRows,
      uploadIds: {
        mxgUploadId: latestMxgUpload.id,
        pxpUploadId: latestPxpUpload.id,
        historicoUploadId: latestHistoricoUpload.id,
        ruaaUploadId: latestRuaaUpload.id,
      },
      generatedByUserId: req.session.user.id,
    });

    const proposals = generationResult.proposals;

    await sequelize.transaction(async (transaction) => {
      await SubstitutionProposal.destroy({ where: {}, transaction });

      if (!proposals.length) {
        return;
      }

      const chunkSize = 1000;
      for (let i = 0; i < proposals.length; i += chunkSize) {
        await SubstitutionProposal.bulkCreate(proposals.slice(i, i + chunkSize), { transaction });
      }
    });

    const totals = proposals.reduce(
      (acc, item) => {
        const assigned = Number(item.assignedHours || 0);
        acc.totalPropuestas += 1;
        acc.totalHorasAsignadas += assigned;
        if (item.hasTurnoConflict) {
          acc.conflictosTurno += 1;
        }
        if (item.hasHorarioConflict) {
          acc.conflictosHorario += 1;
        }
        return acc;
      },
      {
        totalPropuestas: 0,
        totalHorasAsignadas: 0,
        conflictosTurno: 0,
        conflictosHorario: 0,
      }
    );

    req.session.proposalGenerationReport = {
      ...totals,
      teachersWithoutHistoricalReport: generationResult.teachersWithoutHistoricalReport,
    };
    setFlash(
      req,
      'success',
      `Propuestas generadas: ${totals.totalPropuestas} | Horas asignadas: ${totals.totalHorasAsignadas.toFixed(2)} | Conflictos turno: ${totals.conflictosTurno} | Conflictos horario: ${totals.conflictosHorario} | Docentes PxP sin HISTORICO: ${generationResult.teachersWithoutHistoricalReport.totalTeachersWithoutHistorical}.`
    );
    return res.redirect('/analista/propuestas');
  } catch (error) {
    setFlash(req, 'error', `No se pudieron generar propuestas: ${error.message}`);
    return res.redirect('/analista/propuestas');
  }
}

async function updateProposalStatus(req, res) {
  try {
    const proposalId = Number(req.params.id);
    const nextStatus = String(req.body.status || '').toUpperCase();
    const allowed = ['PENDIENTE', 'ACEPTADA', 'RECHAZADA'];

    if (!Number.isInteger(proposalId) || proposalId <= 0 || !allowed.includes(nextStatus)) {
      setFlash(req, 'error', 'Solicitud invalida para cambiar el estado de propuesta.');
      return res.redirect('/analista/propuestas');
    }

    const [updated] = await SubstitutionProposal.update(
      { proposalStatus: nextStatus },
      { where: { id: proposalId } }
    );

    if (!updated) {
      setFlash(req, 'error', 'No se encontro la propuesta a actualizar.');
      return res.redirect('/analista/propuestas');
    }

    setFlash(req, 'success', `Estado actualizado a ${nextStatus}.`);
    return res.redirect('/analista/propuestas');
  } catch (error) {
    setFlash(req, 'error', `No se pudo actualizar el estado: ${error.message}`);
    return res.redirect('/analista/propuestas');
  }
}

async function exportSubstitutionProposalsCsv(req, res) {
  try {
    const rows = await SubstitutionProposal.findAll({
      order: [['id', 'ASC']],
      limit: 20000,
    });

    const headers = [
      'id',
      'proposalStatus',
      'teacherNombre',
      'teacherNumEmp',
      'teacherRfc',
      'requestSubjectId',
      'requestSubjectDesc',
      'requestGroup',
      'requestTurno',
      'assignedHours',
      'requestHours',
      'requestRemainingHours',
      'teacherRemainingBefore',
      'teacherRemainingAfter',
      'subjectMatchType',
      'subjectSimilarity',
      'hasTurnoConflict',
      'hasHorarioConflict',
      'conflictDetails',
      'createdAt',
    ];

    const lines = [headers.join(',')];
    for (const item of rows) {
      const values = headers.map((key) => csvEscape(item.get(key)));
      lines.push(values.join(','));
    }

    const fileName = `propuestas_sustitucion_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(`\uFEFF${lines.join('\n')}`);
  } catch (error) {
    setFlash(req, 'error', `No se pudo exportar CSV: ${error.message}`);
    return res.redirect('/analista/propuestas');
  }
}

function analistaUploadPage(req, res) {
  return res.render('analista-cargas', {
    title: 'Carga de Archivos',
  });
}

async function uploadAnalistaXml(req, res) {
  try {
    if (!req.file) {
      setFlash(req, 'error', 'Debes seleccionar un archivo XML o Excel.');
      return res.redirect('/analista/cargas');
    }

    if (!isAllowedXmlFilename(req.file.originalname)) {
      setFlash(req, 'error', 'Solo se permiten archivos con extension .xml, .xls o .xlsx para este tipo de carga.');
      return res.redirect('/analista/cargas');
    }

    const report = isExcelFilename(req.file.originalname)
      ? parsePayrollWorkbook(req.file.buffer)
      : (() => {
        const xmlContent = decodeXmlBuffer(req.file.buffer);
        const validXml = XMLValidator.validate(xmlContent);
        if (validXml !== true) {
          throw new Error('El archivo no es un XML valido.');
        }
        return parsePayrollXml(xmlContent);
      })();

    await sequelize.transaction(async (transaction) => {
      await purgePreviousUploadByType('PXP', transaction);

      const upload = await XmlUpload.create(
        {
          userId: req.session.user.id,
          originalFileName: req.file.originalname,
          uploadType: 'PXP',
          totalEscuelas: report.summary.totalEscuelas,
          totalDocentes: report.summary.totalDocentes,
          totalPlazas: report.summary.totalPlazas,
          totalAsignaturas: 0,
          totalHorarios: 0,
          totalActividades: 0,
          totalSolicitudesAdicionales: 0,
        },
        { transaction }
      );

      for (const school of report.schools) {
        for (const docente of school.docentes) {
          const teacherImport = await TeacherImport.create(
            {
              uploadId: upload.id,
              cicloId: school.cicloId || null,
              plantelId: school.plantelId || null,
              plantel: school.plantel || null,
              usuarioPlantel: school.usuario || null,
              rfc: docente.rfc || null,
              numEmp: docente.numEmp || null,
              nombre: docente.nombre || null,
              dictamen: docente.dictamen || null,
              turno: docente.turno || null,
              horasNombramiento: docente.horasNombramiento || null,
              horasNomDist: docente.horasNomDist || null,
              funciones: docente.funciones || null,
              cargaReg: docente.cargaReg || null,
              desReg: docente.desReg || null,
              hrsXCub: docente.hrsXCub || null,
              horasCarga: docente.horasCarga || null,
              horasDescarga: docente.horasDescarga || null,
              hrsCgAb1: docente.hrsCgAb1 || null,
              hrsCgAb2: docente.hrsCgAb2 || null,
              hrsCgAb3: docente.hrsCgAb3 || null,
              intHrsCarga: docente.intHrsCarga || null,
              intHrsCgAb1: docente.intHrsCgAb1 || null,
              intHrsCgAb2: docente.intHrsCgAb2 || null,
              intHrsCgAb3: docente.intHrsCgAb3 || null,
              intHrsDescarga: docente.intHrsDescarga || null,
              intHrsDesB1: docente.intHrsDesB1 || null,
              intHrsDesB2: docente.intHrsDesB2 || null,
              intHrsDesB3: docente.intHrsDesB3 || null,
              cfOtraUa: docente.cfOtraUa || null,
            },
            { transaction }
          );

          const positionRows = docente.plazas.map((plaza) => ({
            uploadId: upload.id,
            teacherImportId: teacherImport.id,
            clave: plaza.clave || null,
            horas: plaza.horas || null,
            numeroPlaza: plaza.numeroPlaza || null,
            fechaInicio: plaza.fechaInicio || null,
            fechaFin: plaza.fechaFin || null,
            status: plaza.status || null,
            motivo: plaza.motivo || null,
            observacion: plaza.observacion || null,
          }));

          if (positionRows.length > 0) {
            await PositionImport.bulkCreate(positionRows, { transaction });
          }
        }
      }
    });

    req.session.analistaXmlReport = report;
    setFlash(
      req,
      'success',
      `Archivo procesado: ${report.summary.totalDocentes} docentes y ${report.summary.totalPlazas} plazas.`
    );
    return res.redirect('/analista/cargas');
  } catch (error) {
    setFlash(req, 'error', `No se pudo procesar el archivo PxP: ${error.message}`);
    return res.redirect('/analista/cargas');
  }
}

async function uploadAnalistaHistoricoXml(req, res) {
  try {
    if (!req.file) {
      setFlash(req, 'error', 'Debes seleccionar un archivo XML o Excel.');
      return res.redirect('/analista/cargas');
    }

    if (!isAllowedXmlFilename(req.file.originalname)) {
      setFlash(req, 'error', 'Solo se permiten archivos con extension .xml, .xls o .xlsx para este tipo de carga.');
      return res.redirect('/analista/cargas');
    }

    const historico = isExcelFilename(req.file.originalname)
      ? parseHistoricoWorkbook(req.file.buffer)
      : (() => {
        const xmlContent = decodeXmlBuffer(req.file.buffer);
        const validXml = XMLValidator.validate(xmlContent);
        if (validXml !== true) {
          throw new Error('El archivo no es un XML valido.');
        }
        return parseHistoricoXml(xmlContent);
      })();

    await sequelize.transaction(async (transaction) => {
      await purgePreviousUploadByType('HISTORICO', transaction);

      const upload = await XmlUpload.create(
        {
          userId: req.session.user.id,
          originalFileName: req.file.originalname,
          uploadType: 'HISTORICO',
          totalEscuelas: historico.summary.totalEscuelas,
          totalDocentes: historico.summary.totalDocentes,
          totalPlazas: 0,
          totalAsignaturas: historico.summary.totalAsignaturas,
          totalHorarios: 0,
          totalActividades: 0,
          totalSolicitudesAdicionales: 0,
        },
        { transaction }
      );

      const chunkSize = 1000;
      for (let i = 0; i < historico.subjects.length; i += chunkSize) {
        const chunk = historico.subjects.slice(i, i + chunkSize).map((item) => ({
          uploadId: upload.id,
          plantelId: item.plantelId || null,
          plantelDescripcion: item.plantelDescripcion || null,
          rfc: item.rfc || null,
          numEmp: item.numEmp || null,
          curp: item.curp || null,
          nombre: item.nombre || null,
          dictamen: item.dictamen || null,
          carreraId: item.carreraId || null,
          carreraDescripcion: item.carreraDescripcion || null,
          cicloId: item.cicloId || null,
          cicloDescripcion: item.cicloDescripcion || null,
          asignaturaId: item.asignaturaId || null,
          asignaturaDescripcion: item.asignaturaDescripcion || null,
          turno: item.turno || null,
          modalidadPresencia: item.modalidadPresencia || null,
        }));
        await HistoricalSubjectImport.bulkCreate(chunk, { transaction });
      }
    });

    req.session.analistaHistoricoReport = {
      summary: historico.summary,
      subjectsPreview: historico.subjects.slice(0, 120),
      previewTruncated: historico.subjects.length > 120,
    };

    setFlash(
      req,
      'success',
      `HISTORICO procesado: ${historico.summary.totalDocentes} docentes y ${historico.summary.totalAsignaturas} asignaturas.`
    );
    return res.redirect('/analista/cargas');
  } catch (error) {
    setFlash(req, 'error', `No se pudo procesar HISTORICO: ${error.message}`);
    return res.redirect('/analista/cargas');
  }
}

async function uploadAnalistaRuaaXml(req, res) {
  try {
    if (!req.file) {
      setFlash(req, 'error', 'Debes seleccionar un archivo XML o Excel.');
      return res.redirect('/analista/cargas');
    }

    if (!isAllowedXmlFilename(req.file.originalname)) {
      setFlash(req, 'error', 'Solo se permiten archivos con extension .xml, .xls o .xlsx para este tipo de carga.');
      return res.redirect('/analista/cargas');
    }

    const ruaa = isExcelFilename(req.file.originalname)
      ? parseRuaaWorkbook(req.file.buffer)
      : (() => {
        const xmlContent = decodeXmlBuffer(req.file.buffer);
        const validXml = XMLValidator.validate(xmlContent);
        if (validXml !== true) {
          throw new Error('El archivo no es un XML valido.');
        }
        return parseRuaaXml(xmlContent);
      })();

    await sequelize.transaction(async (transaction) => {
      await purgePreviousUploadByType('RUAA', transaction);

      const upload = await XmlUpload.create(
        {
          userId: req.session.user.id,
          originalFileName: req.file.originalname,
          uploadType: 'RUAA',
          totalEscuelas: 0,
          totalDocentes: ruaa.summary.totalDocentes,
          totalPlazas: 0,
          totalAsignaturas: 0,
          totalHorarios: ruaa.summary.totalHorarios,
          totalActividades: ruaa.summary.totalActividades,
          totalSolicitudesAdicionales: 0,
        },
        { transaction }
      );

      const classRows = ruaa.classSchedules.map((item) => ({
        uploadId: upload.id,
        entryType: 'CLASE',
        numEmp: item.numEmp || null,
        rfc: item.rfc || null,
        nombre: item.nombre || null,
        plantel: item.plantel || null,
        usuarioPlantel: item.usuarioPlantel || null,
        turnoDocente: item.turnoDocente || null,
        carreraId: item.carreraId || null,
        asignaturaId: item.asignaturaId || null,
        asignaturaDescripcion: item.asignaturaDescripcion || null,
        grupo: item.grupo || null,
        academia: item.academia || null,
        horas: item.horas || null,
        actividadClave: null,
        actividadNombre: null,
        lugarActividad: null,
        lunes: item.lunes || null,
        martes: item.martes || null,
        miercoles: item.miercoles || null,
        jueves: item.jueves || null,
        viernes: item.viernes || null,
        sabado: item.sabado || null,
        domingo: item.domingo || null,
      }));

      const activityRows = ruaa.activitySchedules.map((item) => ({
        uploadId: upload.id,
        entryType: 'ACTIVIDAD',
        numEmp: item.numEmp || null,
        rfc: item.rfc || null,
        nombre: item.nombre || null,
        plantel: item.plantel || null,
        usuarioPlantel: item.usuarioPlantel || null,
        turnoDocente: item.turnoDocente || null,
        carreraId: null,
        asignaturaId: null,
        asignaturaDescripcion: null,
        grupo: null,
        academia: null,
        horas: item.horas || null,
        actividadClave: item.actividadClave || null,
        actividadNombre: item.actividadNombre || null,
        lugarActividad: item.lugarActividad || null,
        lunes: item.lunes || null,
        martes: item.martes || null,
        miercoles: item.miercoles || null,
        jueves: item.jueves || null,
        viernes: item.viernes || null,
        sabado: item.sabado || null,
        domingo: item.domingo || null,
      }));

      const chunkSize = 1000;
      for (let i = 0; i < classRows.length; i += chunkSize) {
        await RuaaScheduleImport.bulkCreate(classRows.slice(i, i + chunkSize), { transaction });
      }
      for (let i = 0; i < activityRows.length; i += chunkSize) {
        await RuaaScheduleImport.bulkCreate(activityRows.slice(i, i + chunkSize), { transaction });
      }
    });

    req.session.analistaRuaaReport = {
      summary: ruaa.summary,
      classPreview: ruaa.classSchedules.slice(0, 80),
      activityPreview: ruaa.activitySchedules.slice(0, 80),
      previewTruncated:
        ruaa.classSchedules.length > 80 || ruaa.activitySchedules.length > 80,
    };

    setFlash(
      req,
      'success',
      `RUAA procesado: ${ruaa.summary.totalHorarios} horarios de clase y ${ruaa.summary.totalActividades} actividades.`
    );
    return res.redirect('/analista/cargas');
  } catch (error) {
    setFlash(req, 'error', `No se pudo procesar RUAA: ${error.message}`);
    return res.redirect('/analista/cargas');
  }
}

async function uploadAnalistaMxg(req, res) {
  try {
    if (!req.file) {
      setFlash(req, 'error', 'Debes seleccionar un archivo MXG.xlsx.');
      return res.redirect('/analista/cargas');
    }

    if (!/\.xlsx$/i.test(req.file.originalname || '')) {
      setFlash(req, 'error', 'Solo se permiten archivos con extension .xlsx para MXG.');
      return res.redirect('/analista/cargas');
    }

    const mxg = parseMxgWorkbook(req.file.buffer);

    await sequelize.transaction(async (transaction) => {
      await purgePreviousUploadByType('MXG', transaction);

      const upload = await XmlUpload.create(
        {
          userId: req.session.user.id,
          originalFileName: req.file.originalname,
          uploadType: 'MXG',
          totalEscuelas: 0,
          totalDocentes: mxg.summary.totalDocentes,
          totalPlazas: 0,
          totalAsignaturas: 0,
          totalHorarios: mxg.summary.totalRegistros,
          totalActividades: 0,
          totalSolicitudesAdicionales: mxg.summary.totalSolicitudesAdicionales,
        },
        { transaction }
      );

      const chunkSize = 1000;
      for (let i = 0; i < mxg.rows.length; i += chunkSize) {
        const chunk = mxg.rows.slice(i, i + chunkSize).map((item) => ({
          uploadId: upload.id,
          modalidad: item.modalidad || null,
          plantelId: item.plantelId || null,
          plantelDesc: item.plantelDesc || null,
          cicloId: item.cicloId || null,
          carreraId: item.carreraId || null,
          carreraDesc: item.carreraDesc || null,
          planEstudio: item.planEstudio || null,
          grupo: item.grupo || null,
          turno: item.turno || null,
          asignaturaId: item.asignaturaId || null,
          asignaturaDesc: item.asignaturaDesc || null,
          academiaDesc: item.academiaDesc || null,
          semNivel: item.semNivel || null,
          asigTipo: item.asigTipo || null,
          numEmp: item.numEmp || null,
          rfc: item.rfc || null,
          nombre: item.nombre || null,
          hrsAsig: item.hrsAsig,
          hrsNecesarias: item.hrsNecesarias,
          needsAdditionalHours: item.needsAdditionalHours,
          lunes: item.lunes || null,
          martes: item.martes || null,
          miercoles: item.miercoles || null,
          jueves: item.jueves || null,
          viernes: item.viernes || null,
          sabado: item.sabado || null,
          incidencia: item.incidencia || null,
        }));
        await MxgScheduleImport.bulkCreate(chunk, { transaction });
      }
    });

    req.session.analistaMxgReport = {
      summary: mxg.summary,
      rowsPreview: mxg.rows.slice(0, 120),
      additionalPreview: mxg.additionalRequests.slice(0, 120),
      previewTruncated:
        mxg.rows.length > 120 || mxg.additionalRequests.length > 120,
    };

    setFlash(
      req,
      'success',
      `MXG procesado: ${mxg.summary.totalRegistros} horarios y ${mxg.summary.totalSolicitudesAdicionales} solicitudes de horas adicionales.`
    );
    return res.redirect('/analista/cargas');
  } catch (error) {
    setFlash(req, 'error', `No se pudo procesar MXG.xlsx: ${error.message}`);
    return res.redirect('/analista/cargas');
  }
}

function escuelaDashboard(req, res) {
  return res.render('dashboard-escuela', {
    title: 'Panel Escuela',
  });
}

module.exports = {
  redirectByRole,
  analistaDashboard,
  analistaAnalyticsPage,
  analistaProposalsPage,
  analistaUploadPage,
  uploadAnalistaXml,
  uploadAnalistaHistoricoXml,
  uploadAnalistaRuaaXml,
  uploadAnalistaMxg,
  generateAnalistaSubstitutionProposals,
  updateProposalStatus,
  exportSubstitutionProposalsCsv,
  escuelaDashboard,
};
