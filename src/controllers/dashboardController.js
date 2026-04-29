const { XMLValidator } = require('fast-xml-parser');
const { Op, fn, col, QueryTypes } = require('sequelize');
const { parsePayrollXml, parseHistoricoXml, parseRuaaXml } = require('../services/payrollXmlParser');
const {
  parsePayrollWorkbook,
  parseHistoricoWorkbook,
  parseRuaaWorkbook,
} = require('../services/payrollWorkbookParser');
const { parseMxgWorkbook } = require('../services/mxgParser');
const {
  generateSubstitutionProposals,
  buildMxgRuaaOverlapReport,
} = require('../services/substitutionProposalService');
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

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAsigTipoValue(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function getMxgRowTotalHours(row) {
  const days = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  let minutes = 0;

  for (const day of days) {
    const ranges = parseMxgDayRanges(row[day]);
    for (const range of ranges) {
      minutes += Math.max(0, range.end - range.start);
    }
  }

  return minutes / 60;
}

function normalizeNumEmpKey(value) {
  return String(value || '').trim();
}

function normalizeNumEmpComparable(value) {
  const normalized = normalizeNumEmpKey(value);
  if (!normalized) {
    return '';
  }

  if (!/^[0-9]+(?:\.0+)?$/.test(normalized)) {
    return normalized;
  }

  const integerPart = normalized.replace(/\.0+$/, '');
  const withoutLeadingZeros = integerPart.replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

function getNumEmpLookupKeys(value) {
  const direct = normalizeNumEmpKey(value);
  const comparable = normalizeNumEmpComparable(value);
  const keys = new Set();
  if (direct) {
    keys.add(direct);
  }
  if (comparable) {
    keys.add(comparable);
  }
  return Array.from(keys);
}

function isValidNumEmp(value) {
  const normalized = normalizeNumEmpKey(value);
  if (!normalized) {
    return false;
  }

  return !/^0+(?:\.0+)?$/.test(normalized);
}

function buildPxpTeacherLookup(rows) {
  const byNumEmp = new Map();

  for (const row of rows || []) {
    const numEmp = normalizeNumEmpKey(row.numEmp);
    if (!isValidNumEmp(numEmp)) {
      continue;
    }

    const keys = getNumEmpLookupKeys(numEmp);
    for (const key of keys) {
      if (byNumEmp.has(key)) {
        continue;
      }

      byNumEmp.set(key, {
        rfc: row.rfc || null,
        nombre: row.nombre || null,
      });
    }
  }

  return byNumEmp;
}

function findPxpTeacherByNumEmp(numEmp, pxpTeacherByNumEmp = new Map()) {
  if (!isValidNumEmp(numEmp)) {
    return null;
  }

  const lookupKeys = getNumEmpLookupKeys(numEmp);
  return lookupKeys
    .map((key) => pxpTeacherByNumEmp.get(key))
    .find(Boolean) || null;
}

function buildLabDominanceReport(rows, pxpTeacherByNumEmp = new Map()) {
  const LAB_TYPE = 'L-LABORATORIO';
  const byTeacher = new Map();

  for (const row of rows) {
    const numEmp = normalizeNumEmpKey(row.numEmp);
    if (!isValidNumEmp(numEmp)) {
      continue;
    }

    const pxpTeacher = pxpTeacherByNumEmp.get(numEmp);
    const resolvedRfc = pxpTeacher?.rfc || row.rfc || null;
    const resolvedNombre = pxpTeacher?.nombre || row.nombre || null;
    const teacherKey = numEmp;

    if (!byTeacher.has(teacherKey)) {
      byTeacher.set(teacherKey, {
        numEmp,
        rfc: resolvedRfc,
        nombre: resolvedNombre,
        byType: new Map(),
      });
    }

    const teacher = byTeacher.get(teacherKey);
    if (!teacher.rfc && resolvedRfc) {
      teacher.rfc = resolvedRfc;
    }
    if (!teacher.nombre && resolvedNombre) {
      teacher.nombre = resolvedNombre;
    }

    const asigTipo = normalizeAsigTipoValue(row.asigTipo);
    const rowHours = getMxgRowTotalHours(row);
    if (!asigTipo || rowHours <= 0) {
      continue;
    }

    teacher.byType.set(asigTipo, (teacher.byType.get(asigTipo) || 0) + rowHours);
  }

  const dominantRows = [];

  for (const teacher of byTeacher.values()) {
    const labHours = teacher.byType.get(LAB_TYPE) || 0;
    if (labHours <= 0) {
      continue;
    }

    let maxOtherHours = 0;
    let maxOtherType = '-';
    let totalHours = 0;
    for (const [type, hours] of teacher.byType.entries()) {
      totalHours += hours;
      if (type !== LAB_TYPE && hours > maxOtherHours) {
        maxOtherHours = hours;
        maxOtherType = type;
      }
    }

    if (labHours > maxOtherHours) {
      dominantRows.push({
        numEmp: teacher.numEmp,
        rfc: teacher.rfc,
        nombre: teacher.nombre,
        laboratorioHours: labHours,
        topOtherType: maxOtherType,
        topOtherHours: maxOtherHours,
        totalHours,
        laboratorioShare: totalHours > 0 ? (labHours / totalHours) * 100 : 0,
      });
    }
  }

  dominantRows.sort((a, b) => {
    if (b.laboratorioHours !== a.laboratorioHours) {
      return b.laboratorioHours - a.laboratorioHours;
    }
    if (b.totalHours !== a.totalHours) {
      return b.totalHours - a.totalHours;
    }
    return String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es', { sensitivity: 'base' });
  });

  return {
    targetType: LAB_TYPE,
    totalDocentes: dominantRows.length,
    rows: dominantRows,
  };
}

function normalizeSubjectBase(value) {
  return normalizeText(value)
    .replace(/\b(laboratorio|laboratorios|lab)\b/g, ' ')
    .replace(/\b(teoria|teorico|teorica|teoricas|teoricos)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveMxgTeacherIdentity(row, pxpTeacherByNumEmp = new Map()) {
  const numEmp = normalizeNumEmpKey(row.numEmp);
  const pxpTeacher = findPxpTeacherByNumEmp(numEmp, pxpTeacherByNumEmp);
  const rfc = String(pxpTeacher?.rfc || row.rfc || '').trim();
  const nombre = String(pxpTeacher?.nombre || row.nombre || '').trim();

  return {
    numEmp,
    rfc,
    nombre,
  };
}

function buildTeacherIdentityKey(identity) {
  return [
    normalizeNumEmpKey(identity.numEmp),
    String(identity.rfc || '').trim().toUpperCase(),
    String(identity.nombre || '').trim().toUpperCase(),
  ].join('|');
}

function detectMxgTheoryLabRole(row) {
  const asigTipo = normalizeAsigTipoValue(row.asigTipo);
  if (asigTipo.includes('LABORATORIO') || asigTipo === 'L') {
    return 'LAB';
  }
  if (asigTipo.includes('TEORIA') || asigTipo === 'T') {
    return 'THEORY';
  }

  const desc = normalizeText(row.asignaturaDesc);
  if (desc.includes('laboratorio')) {
    return 'LAB';
  }
  if (desc.includes('teoria')) {
    return 'THEORY';
  }

  return null;
}

function buildTheoryLabCoverageReport(rows, pxpTeacherByNumEmp = new Map()) {
  const byCourse = new Map();

  for (const row of rows || []) {
    const role = detectMxgTheoryLabRole(row);
    if (!role) {
      continue;
    }

    const subjectBase = normalizeSubjectBase(row.asignaturaDesc);
    if (!subjectBase) {
      continue;
    }

    const courseKey = [
      normalizeSchoolPart(row.plantelId),
      String(row.cicloId || '').trim(),
      String(row.carreraId || '').trim(),
      String(row.planEstudio || '').trim(),
      String(row.turno || '').trim(),
      String(row.grupo || '').trim(),
      subjectBase,
    ].join('|');

    if (!byCourse.has(courseKey)) {
      byCourse.set(courseKey, {
        plantelId: normalizeSchoolPart(row.plantelId) || null,
        plantelDesc: String(row.plantelDesc || '').trim() || null,
        cicloId: String(row.cicloId || '').trim() || null,
        carreraId: String(row.carreraId || '').trim() || null,
        carreraDesc: String(row.carreraDesc || '').trim() || null,
        planEstudio: String(row.planEstudio || '').trim() || null,
        turno: String(row.turno || '').trim() || null,
        grupo: String(row.grupo || '').trim() || null,
        subjectBase,
        theorySubjectNames: new Set(),
        labSubjectNames: new Set(),
        theoryTeachers: new Map(),
        labTeachers: new Map(),
      });
    }

    const course = byCourse.get(courseKey);
    const identity = resolveMxgTeacherIdentity(row, pxpTeacherByNumEmp);
    const identityKey = buildTeacherIdentityKey(identity);

    if (role === 'THEORY') {
      course.theorySubjectNames.add(String(row.asignaturaDesc || '').trim());
      course.theoryTeachers.set(identityKey, identity);
    }

    if (role === 'LAB') {
      course.labSubjectNames.add(String(row.asignaturaDesc || '').trim());
      course.labTeachers.set(identityKey, identity);
    }
  }

  const theoryTeacherMissingLabRows = [];
  const labWithoutTheoryRows = [];

  for (const course of byCourse.values()) {
    const theoryCount = course.theoryTeachers.size;
    const labCount = course.labTeachers.size;

    if (theoryCount > 0 && labCount > 0) {
      for (const [teacherKey, teacher] of course.theoryTeachers.entries()) {
        if (course.labTeachers.has(teacherKey)) {
          continue;
        }

        theoryTeacherMissingLabRows.push({
          docente: teacher.nombre || null,
          numEmp: teacher.numEmp || null,
          rfc: teacher.rfc || null,
          grupo: course.grupo || null,
          turno: course.turno || null,
          carrera: course.carreraDesc || course.carreraId || null,
          asignaturaBase: course.subjectBase || null,
          asignaturasTeoria: Array.from(course.theorySubjectNames).filter(Boolean).join(' | ') || null,
          asignaturasLaboratorio: Array.from(course.labSubjectNames).filter(Boolean).join(' | ') || null,
          docentesLaboratorio: Array.from(course.labTeachers.values())
            .map((item) => item.nombre || item.numEmp || item.rfc || 'SIN IDENTIFICADOR')
            .join(' | '),
        });
      }
    }

    if (labCount > 0 && theoryCount === 0) {
      labWithoutTheoryRows.push({
        grupo: course.grupo || null,
        turno: course.turno || null,
        carrera: course.carreraDesc || course.carreraId || null,
        asignaturaBase: course.subjectBase || null,
        asignaturasLaboratorio: Array.from(course.labSubjectNames).filter(Boolean).join(' | ') || null,
        docentesLaboratorio: Array.from(course.labTeachers.values())
          .map((item) => item.nombre || item.numEmp || item.rfc || 'SIN IDENTIFICADOR')
          .join(' | '),
        totalDocentesLaboratorio: labCount,
      });
    }
  }

  theoryTeacherMissingLabRows.sort((a, b) => {
    const groupCompare = String(a.grupo || '').localeCompare(String(b.grupo || ''), 'es', { sensitivity: 'base' });
    if (groupCompare !== 0) {
      return groupCompare;
    }
    return String(a.docente || '').localeCompare(String(b.docente || ''), 'es', { sensitivity: 'base' });
  });

  labWithoutTheoryRows.sort((a, b) => {
    const groupCompare = String(a.grupo || '').localeCompare(String(b.grupo || ''), 'es', { sensitivity: 'base' });
    if (groupCompare !== 0) {
      return groupCompare;
    }
    return String(a.asignaturaBase || '').localeCompare(String(b.asignaturaBase || ''), 'es', { sensitivity: 'base' });
  });

  return {
    totalParesEvaluados: byCourse.size,
    totalDocentesTeoriaSinLaboratorio: theoryTeacherMissingLabRows.length,
    totalGruposLaboratorioSinTeoria: labWithoutTheoryRows.length,
    theoryTeacherMissingLabRows,
    labWithoutTheoryRows,
  };
}

function toTokenSet(value) {
  return new Set(normalizeText(value).split(' ').filter(Boolean));
}

function tokenSimilarity(a, b) {
  const sa = toTokenSet(a);
  const sb = toTokenSet(b);
  if (!sa.size || !sb.size) {
    return 0;
  }

  let inter = 0;
  for (const token of sa) {
    if (sb.has(token)) {
      inter += 1;
    }
  }

  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
}

function hasSubjectMatch(mxgRow, historicalRow) {
  const mxgAsigId = String(mxgRow.asignaturaId || '').trim();
  const histAsigId = String(historicalRow.asignaturaId || '').trim();
  if (mxgAsigId && histAsigId && mxgAsigId === histAsigId) {
    return true;
  }

  const similarity = tokenSimilarity(mxgRow.asignaturaDesc, historicalRow.asignaturaDescripcion);
  return similarity >= 0.52;
}

function hasAreaMatchByAcademia(mxgRow, historicalRow) {
  const academia = normalizeText(mxgRow.academiaDesc);
  const carrera = normalizeText(historicalRow.carreraDescripcion);
  if (!academia || !carrera) {
    return false;
  }

  if (academia.length >= 4 && (carrera.includes(academia) || academia.includes(carrera))) {
    return true;
  }

  return tokenSimilarity(academia, carrera) >= 0.45;
}

function buildMxgNeedsHoursWithoutHistoricalMatchReport(
  mxgRows,
  historicalRows,
  pxpTeacherByNumEmp = new Map(),
  options = {}
) {
  const byNumEmp = new Map();
  const byRfc = new Map();

  for (const item of historicalRows || []) {
    const numEmp = normalizeNumEmpKey(item.numEmp);
    const rfc = String(item.rfc || '').trim().toUpperCase();

    if (isValidNumEmp(numEmp)) {
      if (!byNumEmp.has(numEmp)) {
        byNumEmp.set(numEmp, []);
      }
      byNumEmp.get(numEmp).push(item);
    }

    if (rfc) {
      if (!byRfc.has(rfc)) {
        byRfc.set(rfc, []);
      }
      byRfc.get(rfc).push(item);
    }
  }

  const rows = [];
  const uniqueTeachers = new Set();

  for (const mxgRow of mxgRows || []) {
    const hrsNecesarias = toDecimal(mxgRow.hrsNecesarias);
    if (hrsNecesarias <= 0) {
      continue;
    }

    const identity = resolveMxgTeacherIdentity(mxgRow, pxpTeacherByNumEmp);
    const pxpTeacher = findPxpTeacherByNumEmp(identity.numEmp, pxpTeacherByNumEmp);
    const mustUsePxpName = isValidNumEmp(identity.numEmp);
    const resolvedDisplayName = mustUsePxpName
      ? (String(pxpTeacher?.nombre || '').trim() || 'SIN NOMBRE EN PXP')
      : (identity.nombre || mxgRow.nombre || null);
    const teacherKey = buildTeacherIdentityKey(identity);
    uniqueTeachers.add(teacherKey);

    const candidates = [];
    const seen = new Set();
    const numEmp = normalizeNumEmpKey(identity.numEmp);
    const rfc = String(identity.rfc || '').trim().toUpperCase();

    if (isValidNumEmp(numEmp)) {
      for (const item of byNumEmp.get(numEmp) || []) {
        const key = `${item.id || ''}|${item.asignaturaId || ''}|${item.carreraId || ''}|${item.cicloId || ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(item);
        }
      }
    }

    if (rfc) {
      for (const item of byRfc.get(rfc) || []) {
        const key = `${item.id || ''}|${item.asignaturaId || ''}|${item.carreraId || ''}|${item.cicloId || ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(item);
        }
      }
    }

    const subjectMatched = candidates.some((item) => hasSubjectMatch(mxgRow, item));
    const areaMatched = candidates.some((item) => hasAreaMatchByAcademia(mxgRow, item));

    if (subjectMatched || areaMatched) {
      continue;
    }

    rows.push({
      docente: resolvedDisplayName,
      numEmp: identity.numEmp || null,
      rfc: identity.rfc || null,
      grupo: String(mxgRow.grupo || '').trim() || null,
      turno: String(mxgRow.turno || '').trim() || null,
      asignaturaId: String(mxgRow.asignaturaId || '').trim() || null,
      asignaturaDesc: String(mxgRow.asignaturaDesc || '').trim() || null,
      academiaDesc: String(mxgRow.academiaDesc || '').trim() || null,
      carreraDesc: String(mxgRow.carreraDesc || '').trim() || null,
      hrsNecesarias,
      totalRegistrosHistDocente: candidates.length,
      motivo: candidates.length === 0
        ? 'El docente no tiene registros en HIST.'
        : 'El docente tiene HIST, pero sin coincidencia de materia ni de area (academia MXG vs carrera HIST).',
    });
  }

  rows.sort((a, b) => {
    if (b.hrsNecesarias !== a.hrsNecesarias) {
      return b.hrsNecesarias - a.hrsNecesarias;
    }

    const teacherCompare = String(a.docente || '').localeCompare(String(b.docente || ''), 'es', { sensitivity: 'base' });
    if (teacherCompare !== 0) {
      return teacherCompare;
    }

    return String(a.asignaturaDesc || '').localeCompare(String(b.asignaturaDesc || ''), 'es', { sensitivity: 'base' });
  });

  return {
    hasHistoricalSource: Boolean(options.hasHistoricalSource),
    totalRegistrosEvaluados: (mxgRows || []).filter((item) => toDecimal(item.hrsNecesarias) > 0).length,
    totalDocentesConHrsNecesarias: uniqueTeachers.size,
    totalRegistrosSinCoincidenciaHist: rows.length,
    totalDocentesSinCoincidenciaHist: new Set(rows.map((item) => buildTeacherIdentityKey(item))).size,
    rows,
  };
}

function extractBirthDateFromRfc(rfc, referenceDate = new Date()) {
  const clean = String(rfc || '').trim().toUpperCase();
  const match = clean.match(/^[A-Z&Ñ]{3,4}(\d{2})(\d{2})(\d{2})/);
  if (!match) {
    return null;
  }

  const yy = Number(match[1]);
  const mm = Number(match[2]);
  const dd = Number(match[3]);
  if (!Number.isInteger(yy) || !Number.isInteger(mm) || !Number.isInteger(dd)) {
    return null;
  }

  const currentYear = referenceDate.getFullYear();
  const currentCentury = Math.floor(currentYear / 100) * 100;
  let fullYear = currentCentury + yy;
  let birthDate = new Date(fullYear, mm - 1, dd);

  if (
    birthDate.getFullYear() !== fullYear
    || birthDate.getMonth() !== mm - 1
    || birthDate.getDate() !== dd
  ) {
    return null;
  }

  if (birthDate > referenceDate) {
    fullYear -= 100;
    birthDate = new Date(fullYear, mm - 1, dd);
  }

  let age = referenceDate.getFullYear() - birthDate.getFullYear();
  const monthDelta = referenceDate.getMonth() - birthDate.getMonth();
  const dayDelta = referenceDate.getDate() - birthDate.getDate();
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
    age -= 1;
  }

  if (age < 18) {
    fullYear -= 100;
    birthDate = new Date(fullYear, mm - 1, dd);
    age = referenceDate.getFullYear() - birthDate.getFullYear();
    const monthDelta2 = referenceDate.getMonth() - birthDate.getMonth();
    const dayDelta2 = referenceDate.getDate() - birthDate.getDate();
    if (monthDelta2 < 0 || (monthDelta2 === 0 && dayDelta2 < 0)) {
      age -= 1;
    }
  }

  if (age < 18 || age > 100) {
    return null;
  }

  return birthDate;
}

function calculateAgeFromRfc(rfc, referenceDate = new Date()) {
  const birthDate = extractBirthDateFromRfc(rfc, referenceDate);
  if (!birthDate) {
    return null;
  }

  let age = referenceDate.getFullYear() - birthDate.getFullYear();
  const monthDelta = referenceDate.getMonth() - birthDate.getMonth();
  const dayDelta = referenceDate.getDate() - birthDate.getDate();
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
    age -= 1;
  }
  return age;
}

function buildAcademiaAgeRiskReport(mxgRows, pxpTeacherByNumEmp = new Map(), referenceDate = new Date()) {
  const SENIOR_AGE = 60;
  const YOUNG_AGE = 45;
  const byAcademia = new Map();
  const teacherAgesForChart = [];

  for (const row of mxgRows || []) {
    const academiaDesc = String(row.academiaDesc || '').trim() || 'Sin academia';
    const identity = resolveMxgTeacherIdentity(row, pxpTeacherByNumEmp);
    const teacherKey = buildTeacherIdentityKey(identity);
    const age = calculateAgeFromRfc(identity.rfc, referenceDate);

    if (!byAcademia.has(academiaDesc)) {
      byAcademia.set(academiaDesc, {
        academiaDesc,
        teachers: new Map(),
        teachersWithoutAge: 0,
      });
    }

    const academia = byAcademia.get(academiaDesc);
    if (academia.teachers.has(teacherKey)) {
      continue;
    }

    academia.teachers.set(teacherKey, {
      docente: identity.nombre || row.nombre || null,
      numEmp: identity.numEmp || null,
      rfc: identity.rfc || null,
      age,
    });

    if (age === null) {
      academia.teachersWithoutAge += 1;
      continue;
    }

    teacherAgesForChart.push({
      academiaDesc,
      docente: identity.nombre || row.nombre || 'Docente sin nombre',
      edad: age,
    });
  }

  const rows = Array.from(byAcademia.values()).map((academia) => {
    const teachers = Array.from(academia.teachers.values());
    const ages = teachers.map((item) => item.age).filter((value) => Number.isInteger(value));
    const seniorCount = ages.filter((value) => value >= SENIOR_AGE).length;
    const youngCount = ages.filter((value) => value < YOUNG_AGE).length;
    const averageAge = ages.length
      ? ages.reduce((acc, value) => acc + value, 0) / ages.length
      : null;
    const oldestAge = ages.length ? Math.max(...ages) : null;
    const youngestAge = ages.length ? Math.min(...ages) : null;

    let riskLevel = 'BAJO';
    if (seniorCount > 0 && youngCount === 0) {
      riskLevel = 'ALTO';
    } else if (seniorCount > 0 && youngCount === 1) {
      riskLevel = 'MEDIO';
    }

    return {
      academiaDesc: academia.academiaDesc,
      totalDocentes: teachers.length,
      docentesConEdad: ages.length,
      docentesSinEdad: academia.teachersWithoutAge,
      averageAge: averageAge !== null ? Number(averageAge.toFixed(1)) : null,
      youngestAge,
      oldestAge,
      seniorCount,
      youngCount,
      riskLevel,
    };
  });

  rows.sort((a, b) => {
    const riskOrder = { ALTO: 0, MEDIO: 1, BAJO: 2 };
    const riskCompare = riskOrder[a.riskLevel] - riskOrder[b.riskLevel];
    if (riskCompare !== 0) {
      return riskCompare;
    }
    if ((b.oldestAge || 0) !== (a.oldestAge || 0)) {
      return (b.oldestAge || 0) - (a.oldestAge || 0);
    }
    return String(a.academiaDesc || '').localeCompare(String(b.academiaDesc || ''), 'es', { sensitivity: 'base' });
  });

  return {
    seniorAgeThreshold: SENIOR_AGE,
    youngAgeThreshold: YOUNG_AGE,
    totalAcademias: rows.length,
    academiasConRiesgoAlto: rows.filter((item) => item.riskLevel === 'ALTO').length,
    academiasConRiesgoMedio: rows.filter((item) => item.riskLevel === 'MEDIO').length,
    totalDocentesConEdad: teacherAgesForChart.length,
    rows,
    teacherAgesForChart,
  };
}

function normalizeCategoryKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function toDecimal(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number.parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function containsTecnico(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .includes('TECNICO');
}

function splitCategoryCodes(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) {
    return [];
  }

  const parts = text.split(/[^A-Za-z0-9]+/).map((token) => token.trim()).filter(Boolean);
  if (!parts.length) {
    return [text];
  }

  return Array.from(new Set(parts));
}

async function loadCategorySimpleMap() {
  try {
    const rows = await sequelize.query('SELECT CVE, CAT_SIMPLE FROM CATEG', {
      type: QueryTypes.SELECT,
    });

    const byCve = new Map();
    for (const row of rows || []) {
      const cve = normalizeCategoryKey(row.CVE || row.cve);
      if (!cve) {
        continue;
      }

      if (!byCve.has(cve)) {
        byCve.set(cve, String(row.CAT_SIMPLE || row.cat_simple || row.catSimple || '').trim());
      }
    }

    return {
      byCve,
      sourceAvailable: true,
      sourceError: null,
    };
  } catch (error) {
    return {
      byCve: new Map(),
      sourceAvailable: false,
      sourceError: error.message,
    };
  }
}

function buildTecnicosDocentesConCargaReport({
  mxgRows,
  pxpTeachers,
  categorySimpleByCve,
  categorySourceAvailable,
  categorySourceError,
}) {
  const teacherByKey = new Map();
  for (const teacher of pxpTeachers || []) {
    const numEmp = normalizeNumEmpKey(teacher.numEmp);
    const rfc = String(teacher.rfc || '').trim();
    const nombre = String(teacher.nombre || '').trim();
    const key = `${numEmp}|${rfc}|${nombre}`;
    if (!teacherByKey.has(key)) {
      teacherByKey.set(key, teacher);
    }
  }

  const rowsByTeacher = new Map();
  for (const row of mxgRows || []) {
    const hrsFtg = toDecimal(row.hrsFtg);
    const hrsNecesarias = toDecimal(row.hrsNecesarias);
    if (hrsFtg === 0 && hrsNecesarias === 0) {
      continue;
    }

    const numEmp = normalizeNumEmpKey(row.numEmp);
    const rfc = String(row.rfc || '').trim();
    const nombre = String(row.nombre || '').trim();
    const key = `${numEmp}|${rfc}|${nombre}`;
    const pxpTeacher = teacherByKey.get(key)
      || teacherByKey.get(`${numEmp}|${rfc}|`)
      || teacherByKey.get(`${numEmp}||${nombre}`)
      || null;

    if (!rowsByTeacher.has(key)) {
      rowsByTeacher.set(key, {
        numEmp: numEmp || null,
        rfc: rfc || null,
        nombre: String(row.nombre || pxpTeacher?.nombre || '').trim() || null,
        dictamen: String(pxpTeacher?.dictamen || '').trim(),
        plazaCodes: new Set(),
        totalHrsFtg: 0,
        totalHrsNecesarias: 0,
      });
    }

    const current = rowsByTeacher.get(key);
    current.totalHrsFtg += hrsFtg;
    current.totalHrsNecesarias += hrsNecesarias;

    for (const code of splitCategoryCodes(row.plaza)) {
      current.plazaCodes.add(code);
    }
  }

  const rows = [];
  for (const item of rowsByTeacher.values()) {
    const dictamenSimple = categorySimpleByCve.get(normalizeCategoryKey(item.dictamen)) || '';
    const dictamenIsTecnico = containsTecnico(dictamenSimple);

    const plazasInfo = Array.from(item.plazaCodes).map((code) => {
      const catSimple = categorySimpleByCve.get(normalizeCategoryKey(code)) || '';
      return {
        code,
        catSimple,
        isTecnico: containsTecnico(catSimple),
      };
    });

    const tecnicoPlazas = plazasInfo.filter((p) => p.isTecnico);
    const plazasIsTecnico = tecnicoPlazas.length > 0;

    if (!dictamenIsTecnico && !plazasIsTecnico) {
      continue;
    }

    rows.push({
      numEmp: item.numEmp,
      rfc: item.rfc,
      nombre: item.nombre,
      categoriaDictaminada: item.dictamen || '-',
      catSimpleDictamen: dictamenSimple || '-',
      categoriaPlaza: Array.from(item.plazaCodes).join(', ') || '-',
      catSimplePlaza: tecnicoPlazas.map((p) => `${p.code}: ${p.catSimple}`).join(' | ') || '-',
      totalHrsFtg: Number(item.totalHrsFtg.toFixed(2)),
      totalHrsNecesarias: Number(item.totalHrsNecesarias.toFixed(2)),
      esTecnicoPorDictamen: dictamenIsTecnico,
      esTecnicoPorPlaza: plazasIsTecnico,
    });
  }

  rows.sort((a, b) => {
    const cargaA = Math.abs(a.totalHrsFtg) + Math.abs(a.totalHrsNecesarias);
    const cargaB = Math.abs(b.totalHrsFtg) + Math.abs(b.totalHrsNecesarias);
    if (cargaB !== cargaA) {
      return cargaB - cargaA;
    }
    return String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es', { sensitivity: 'base' });
  });

  return {
    totalDocentes: rows.length,
    totalHrsFtg: Number(rows.reduce((acc, row) => acc + row.totalHrsFtg, 0).toFixed(2)),
    totalHrsNecesarias: Number(rows.reduce((acc, row) => acc + row.totalHrsNecesarias, 0).toFixed(2)),
    categorySourceAvailable,
    categorySourceError,
    rows,
  };
}

function normalizeSchoolPart(value) {
  return String(value || '').trim();
}

function buildSchoolKey(plantelId, plantelDesc) {
  const id = encodeURIComponent(normalizeSchoolPart(plantelId));
  const desc = encodeURIComponent(normalizeSchoolPart(plantelDesc));
  return `${id}|${desc}`;
}

function parseSchoolKey(schoolKey) {
  const raw = String(schoolKey || '').trim();
  if (!raw || !raw.includes('|')) {
    return { plantelId: '', plantelDesc: '' };
  }

  const [idPart, ...descParts] = raw.split('|');
  const descPart = descParts.join('|');
  return {
    plantelId: decodeURIComponent(idPart || ''),
    plantelDesc: decodeURIComponent(descPart || ''),
  };
}

function buildSchoolLabel(plantelId, plantelDesc) {
  const id = normalizeSchoolPart(plantelId);
  const desc = normalizeSchoolPart(plantelDesc);
  return [id, desc].filter(Boolean).join(' - ');
}

function buildSchoolWhere(plantelId, plantelDesc, idField, descField) {
  const id = normalizeSchoolPart(plantelId);
  const desc = normalizeSchoolPart(plantelDesc);

  if (id && idField && desc && descField) {
    return {
      [Op.or]: [
        { [idField]: id },
        { [descField]: desc },
      ],
    };
  }

  if (id && idField) {
    return { [idField]: id };
  }

  if (desc && descField) {
    return { [descField]: desc };
  }

  return null;
}

function buildRuaaSchoolWhere(plantelId, plantelDesc) {
  const id = normalizeSchoolPart(plantelId);
  const desc = normalizeSchoolPart(plantelDesc);
  const filters = [];

  if (desc) {
    filters.push({ plantel: desc });
    filters.push({ plantel: { [Op.like]: `%${desc}%` } });
  }

  if (id) {
    filters.push({ plantel: id });
    filters.push({ plantel: { [Op.like]: `%${id}%` } });
  }

  if (!filters.length) {
    return null;
  }

  return { [Op.or]: filters };
}

function buildSchoolOptionsFromRows(rows, idField, descField) {
  const byKey = new Map();

  for (const row of rows || []) {
    const plantelId = normalizeSchoolPart(row[idField]);
    const plantelDesc = normalizeSchoolPart(row[descField]);
    if (!plantelId && !plantelDesc) {
      continue;
    }

    const key = buildSchoolKey(plantelId, plantelDesc);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        label: buildSchoolLabel(plantelId, plantelDesc) || 'Escuela sin nombre',
        plantelId,
        plantelDesc,
      });
    }
  }

  return Array.from(byKey.values()).sort((a, b) =>
    a.label.localeCompare(b.label, 'es', { sensitivity: 'base' })
  );
}

function resolveActiveSchool(req, schoolOptions) {
  const requestedKey = String((req.query && req.query.schoolKey) || (req.body && req.body.schoolKey) || '').trim();
  if (requestedKey) {
    req.session.analistaActiveSchoolKey = requestedKey;
  }

  let activeSchoolKey = requestedKey || String(req.session.analistaActiveSchoolKey || '').trim();
  if (!schoolOptions.some((item) => item.key === activeSchoolKey)) {
    activeSchoolKey = schoolOptions[0]?.key || '';
  }

  if (activeSchoolKey) {
    req.session.analistaActiveSchoolKey = activeSchoolKey;
  }

  const activeSchool = schoolOptions.find((item) => item.key === activeSchoolKey) || null;
  return {
    activeSchoolKey,
    activeSchool,
  };
}

async function getSchoolOptionsFromMxg() {
  const rows = await MxgScheduleImport.findAll({
    attributes: ['plantelId', 'plantelDesc'],
    raw: true,
  });

  return buildSchoolOptionsFromRows(rows, 'plantelId', 'plantelDesc');
}

async function findLatestUploadForSchool(uploadType, model, schoolWhere) {
  const uploads = await XmlUpload.findAll({
    where: { uploadType },
    order: [['uploadedAt', 'DESC']],
    attributes: ['id', 'uploadedAt'],
    raw: true,
  });

  for (const upload of uploads) {
    const exists = await model.count({
      where: {
        uploadId: upload.id,
        ...(schoolWhere || {}),
      },
    });
    if (exists > 0) {
      return upload;
    }
  }

  return null;
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
      row.asignaturaId || row.asignaturaDesc || `ASIG-ROW-${row.id}`,
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

async function getRecentUploads() {
  return XmlUpload.findAll({
    order: [['uploadedAt', 'DESC']],
    limit: 20,
    include: [{ model: User, attributes: ['id', 'name', 'username'] }],
  });
}

function parsePageNumber(value) {
  const parsed = Number.parseInt(String(value || '1'), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function buildPaginationHref(basePath, originalQuery, pageParam, pageNumber) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(originalQuery || {})) {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item !== undefined && item !== null && item !== '') {
          params.append(key, String(item));
        }
      });
      continue;
    }

    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }

  if (pageNumber <= 1) {
    params.delete(pageParam);
  } else {
    params.set(pageParam, String(pageNumber));
  }

  const queryString = params.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

function paginateCollection(items, currentPage, pageSize, pageParam, originalQuery, basePath) {
  const safeItems = Array.isArray(items) ? items : [];
  const totalItems = safeItems.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize) || 1);
  const page = Math.min(parsePageNumber(currentPage), totalPages);
  const startIndex = (page - 1) * pageSize;
  const pagedItems = safeItems.slice(startIndex, startIndex + pageSize);
  const startItem = totalItems === 0 ? 0 : startIndex + 1;
  const endItem = totalItems === 0 ? 0 : startIndex + pagedItems.length;

  return {
    items: pagedItems,
    pagination: {
      currentPage: page,
      totalPages,
      totalItems,
      startItem,
      endItem,
      hasPrev: page > 1,
      hasNext: page < totalPages,
      prevHref:
        page > 1
          ? buildPaginationHref(basePath, originalQuery, pageParam, page - 1)
          : null,
      nextHref:
        page < totalPages
          ? buildPaginationHref(basePath, originalQuery, pageParam, page + 1)
          : null,
    },
  };
}

async function getRecentUploadsPage(currentPage, pageSize) {
  const totalItems = await XmlUpload.count();
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize) || 1);
  const page = Math.min(parsePageNumber(currentPage), totalPages);
  const uploads = await XmlUpload.findAll({
    order: [['uploadedAt', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    include: [{ model: User, attributes: ['id', 'name', 'username'] }],
  });

  return {
    items: uploads,
    totalItems,
    totalPages,
    currentPage: page,
  };
}

async function analistaDashboard(req, res) {
  const schoolOptions = await getSchoolOptionsFromMxg();
  const { activeSchoolKey, activeSchool } = resolveActiveSchool(req, schoolOptions);

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
    schoolOptions,
    activeSchoolKey,
    activeSchoolLabel: activeSchool?.label || '',
    horasSolicitadasPorAcademia,
    detalleSolicitudesPorAcademia,
    horasSolicitadasTotales,
    escuelaHorasSolicitadas,
  });
}

async function analistaAnalyticsPage(req, res) {
  const schoolOptions = await getSchoolOptionsFromMxg();
  const { activeSchoolKey, activeSchool } = resolveActiveSchool(req, schoolOptions);

  let escuelaHorasSolicitadas = activeSchool?.label || null;
  let mxgHeatmap = null;
  let hrsXCubHistogram = [];

  const filterSemNivel = req.query.semNivel || '';
  const filterAcademia = req.query.academia || '';
  const filterAsigTipo = req.query.asigTipo || '';
  const filterModalidad = req.query.modalidad || '';
  const filterCarreraDesc = req.query.carreraDesc || '';

  let semNivelOptions = [];
  let academiaOptions = [];
  let asigTipoOptions = [];
  let modalidadOptions = [];
  let carreraDescOptions = [];
  let labDominanceReport = null;
  let theoryLabCoverageReport = null;
  let mxgNeedsHoursWithoutHistoricalMatchReport = null;
  let academiaAgeRiskReport = null;
  let tecnicoDocentesConCargaReport = null;
  let mxgRuaaOverlapReport = null;
  let latestPxpUpload = null;
  let pxpTeacherByNumEmp = new Map();
  let pxpTeacherRows = [];
  let hasSemNivelField = false;
  let hasAsigTipoField = false;

  if (activeSchool) {
    const schoolWhereMxg = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantelDesc');
    const schoolWherePxp = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantel');
    const schoolWhereHistorico = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantelDescripcion');

    const latestMxgUpload = await findLatestUploadForSchool('MXG', MxgScheduleImport, schoolWhereMxg);
    latestPxpUpload = await findLatestUploadForSchool('PXP', TeacherImport, schoolWherePxp);

    if (latestPxpUpload) {
      pxpTeacherRows = await TeacherImport.findAll({
        where: {
          uploadId: latestPxpUpload.id,
          ...(schoolWherePxp || {}),
        },
        attributes: ['numEmp', 'rfc', 'nombre', 'dictamen'],
        raw: true,
      });
      pxpTeacherByNumEmp = buildPxpTeacherLookup(pxpTeacherRows);
    }

    if (latestMxgUpload) {
      const queryInterface = sequelize.getQueryInterface();
      const mxgTableColumns = await queryInterface.describeTable('mxg_schedule_imports').catch(() => ({}));
      hasSemNivelField = Boolean(mxgTableColumns.semNivel);
      hasAsigTipoField = Boolean(mxgTableColumns.asigTipo);

      const filterAttributes = ['academiaDesc', 'modalidad', 'carreraDesc'];
      if (hasSemNivelField) {
        filterAttributes.push('semNivel');
      }
      if (hasAsigTipoField) {
        filterAttributes.push('asigTipo');
      }

      const mxgRowsForFilters = await MxgScheduleImport.findAll({
        where: {
          uploadId: latestMxgUpload.id,
          ...(schoolWhereMxg || {}),
        },
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

      const heatmapWhere = {
        uploadId: latestMxgUpload.id,
        ...(schoolWhereMxg || {}),
      };
      if (filterSemNivel && hasSemNivelField) heatmapWhere.semNivel = filterSemNivel;
      if (filterAcademia) heatmapWhere.academiaDesc = filterAcademia;
      if (filterAsigTipo && hasAsigTipoField) heatmapWhere.asigTipo = filterAsigTipo;
      if (filterModalidad) heatmapWhere.modalidad = filterModalidad;
      if (filterCarreraDesc) heatmapWhere.carreraDesc = filterCarreraDesc;

      const mxgRowsForHeatmap = await MxgScheduleImport.findAll({
        where: heatmapWhere,
        attributes: [
          'id',
          'plantelId',
          'carreraId',
          'grupo',
          'asignaturaId',
          'asignaturaDesc',
          'lunes',
          'martes',
          'miercoles',
          'jueves',
          'viernes',
          'sabado',
        ],
      });

      mxgHeatmap = buildMxgHeatmap(mxgRowsForHeatmap);

      if (hasAsigTipoField) {
        const mxgRowsForLabDominance = await MxgScheduleImport.findAll({
          where: {
            uploadId: latestMxgUpload.id,
            ...(schoolWhereMxg || {}),
          },
          attributes: ['numEmp', 'rfc', 'nombre', 'asigTipo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
          raw: true,
        });
        labDominanceReport = buildLabDominanceReport(mxgRowsForLabDominance, pxpTeacherByNumEmp);

        const mxgRowsForTheoryLabCoverage = await MxgScheduleImport.findAll({
          where: {
            uploadId: latestMxgUpload.id,
            ...(schoolWhereMxg || {}),
          },
          attributes: [
            'plantelId',
            'plantelDesc',
            'cicloId',
            'carreraId',
            'carreraDesc',
            'planEstudio',
            'grupo',
            'turno',
            'asignaturaDesc',
            'asigTipo',
            'numEmp',
            'rfc',
            'nombre',
          ],
          raw: true,
        });

        theoryLabCoverageReport = buildTheoryLabCoverageReport(mxgRowsForTheoryLabCoverage, pxpTeacherByNumEmp);
      }

      const mxgRowsForTecnicosConCarga = await MxgScheduleImport.findAll({
        where: {
          uploadId: latestMxgUpload.id,
          ...(schoolWhereMxg || {}),
        },
        attributes: ['numEmp', 'rfc', 'nombre', 'plaza', 'hrsFtg', 'hrsNecesarias'],
        raw: true,
      });

      const categoryInfo = await loadCategorySimpleMap();
      tecnicoDocentesConCargaReport = buildTecnicosDocentesConCargaReport({
        mxgRows: mxgRowsForTecnicosConCarga,
        pxpTeachers: pxpTeacherRows,
        categorySimpleByCve: categoryInfo.byCve,
        categorySourceAvailable: categoryInfo.sourceAvailable,
        categorySourceError: categoryInfo.sourceError,
      });

      const mxgRowsForAcademiaAgeRisk = await MxgScheduleImport.findAll({
        where: heatmapWhere,
        attributes: ['numEmp', 'rfc', 'nombre', 'academiaDesc'],
        raw: true,
      });

      academiaAgeRiskReport = buildAcademiaAgeRiskReport(mxgRowsForAcademiaAgeRisk, pxpTeacherByNumEmp);

      const latestHistoricoUpload = await findLatestUploadForSchool('HISTORICO', HistoricalSubjectImport, schoolWhereHistorico);
      const [mxgRowsForNeedsVsHist, historicalRowsForNeedsVsHist] = await Promise.all([
        MxgScheduleImport.findAll({
          where: {
            uploadId: latestMxgUpload.id,
            ...(schoolWhereMxg || {}),
            needsAdditionalHours: true,
            hrsNecesarias: { [Op.gt]: 0 },
          },
          attributes: [
            'numEmp',
            'rfc',
            'nombre',
            'grupo',
            'turno',
            'asignaturaId',
            'asignaturaDesc',
            'academiaDesc',
            'carreraDesc',
            'hrsNecesarias',
          ],
          raw: true,
        }),
        latestHistoricoUpload
          ? HistoricalSubjectImport.findAll({
            where: {
              uploadId: latestHistoricoUpload.id,
              ...(schoolWhereHistorico || {}),
            },
            attributes: ['id', 'numEmp', 'rfc', 'asignaturaId', 'asignaturaDescripcion', 'carreraDescripcion', 'carreraId', 'cicloId'],
            raw: true,
          })
          : Promise.resolve([]),
      ]);

      mxgNeedsHoursWithoutHistoricalMatchReport = buildMxgNeedsHoursWithoutHistoricalMatchReport(
        mxgRowsForNeedsVsHist,
        historicalRowsForNeedsVsHist,
        pxpTeacherByNumEmp,
        { hasHistoricalSource: Boolean(latestHistoricoUpload) }
      );

      const schoolWhereRuaa = buildRuaaSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc);
      const latestRuaaUpload = await findLatestUploadForSchool('RUAA', RuaaScheduleImport, schoolWhereRuaa);
      if (latestRuaaUpload) {
        const [mxgRowsForOverlap, ruaaRowsForOverlap] = await Promise.all([
          MxgScheduleImport.findAll({
            where: {
              uploadId: latestMxgUpload.id,
              ...(schoolWhereMxg || {}),
            },
            attributes: ['numEmp', 'rfc', 'nombre', 'asignaturaDesc', 'grupo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
            raw: true,
          }),
          RuaaScheduleImport.findAll({
            where: {
              uploadId: latestRuaaUpload.id,
              ...(schoolWhereRuaa || {}),
            },
            attributes: ['numEmp', 'rfc', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'],
            raw: true,
          }),
        ]);
        mxgRuaaOverlapReport = buildMxgRuaaOverlapReport(mxgRowsForOverlap, ruaaRowsForOverlap);
      }
    }

    if (latestPxpUpload) {
      const histogramWhere = {
        uploadId: latestPxpUpload.id,
        ...(schoolWherePxp || {}),
      };

      const freqRows = await TeacherImport.findAll({
        where: {
          ...histogramWhere,
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
          ...histogramWhere,
          hrsXCub: { [Op.notRegexp]: '^-?[0-9]+(\\.[0-9]+)?$' },
        },
      });
      if (nonNumericCount > 0) {
        hrsXCubHistogram.push({ valor: '(sin valor)', base: null, cantidad: nonNumericCount });
      }
    }
  }

  return res.render('analista-analitica', {
    title: 'Analitica MXG',
    mxgHeatmap,
    escuelaHorasSolicitadas,
    hrsXCubHistogram,
    labDominanceReport,
    theoryLabCoverageReport,
    mxgNeedsHoursWithoutHistoricalMatchReport,
    academiaAgeRiskReport,
    tecnicoDocentesConCargaReport,
    mxgRuaaOverlapReport,
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
    schoolOptions,
    activeSchoolKey,
    activeSchoolLabel: activeSchool?.label || '',
  });
}

async function analistaProposalsPage(req, res) {
  const schoolOptions = await getSchoolOptionsFromMxg();
  const { activeSchoolKey, activeSchool } = resolveActiveSchool(req, schoolOptions);

  let proposalGenerationReport = null;
  const reportsBySchool = req.session.proposalGenerationReports || {};
  if (activeSchoolKey && reportsBySchool[activeSchoolKey]) {
    proposalGenerationReport = reportsBySchool[activeSchoolKey];
    delete reportsBySchool[activeSchoolKey];
    req.session.proposalGenerationReports = reportsBySchool;
  }

  let recentProposals = [];
  if (activeSchoolKey) {
    recentProposals = await SubstitutionProposal.findAll({
      where: { schoolKey: activeSchoolKey },
      order: [['createdAt', 'DESC']],
      limit: 200,
    });
  }

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
    schoolOptions,
    activeSchoolKey,
    activeSchoolLabel: activeSchool?.label || '',
  });
}

async function generateAnalistaSubstitutionProposals(req, res) {
  try {
    const schoolOptions = await getSchoolOptionsFromMxg();
    const { activeSchoolKey, activeSchool } = resolveActiveSchool(req, schoolOptions);
    if (!activeSchool) {
      setFlash(req, 'error', 'No hay escuela seleccionada. Carga MXG y elige una escuela.');
      return res.redirect('/analista/propuestas');
    }

    const schoolWhereMxg = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantelDesc');
    const schoolWherePxp = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantel');
    const schoolWhereHistorico = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantelDescripcion');
    const schoolWhereRuaa = buildRuaaSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc);

    const [latestMxgUpload, latestPxpUpload, latestHistoricoUpload, latestRuaaUpload] = await Promise.all([
      findLatestUploadForSchool('MXG', MxgScheduleImport, schoolWhereMxg),
      findLatestUploadForSchool('PXP', TeacherImport, schoolWherePxp),
      findLatestUploadForSchool('HISTORICO', HistoricalSubjectImport, schoolWhereHistorico),
      findLatestUploadForSchool('RUAA', RuaaScheduleImport, schoolWhereRuaa),
    ]);

    if (!latestMxgUpload || !latestPxpUpload || !latestHistoricoUpload || !latestRuaaUpload) {
      const faltantes = [];
      if (!latestMxgUpload) faltantes.push('MXG');
      if (!latestPxpUpload) faltantes.push('PxP');
      if (!latestHistoricoUpload) faltantes.push('HISTORICO');
      if (!latestRuaaUpload) faltantes.push('RUAA');
      setFlash(
        req,
        'error',
        `Para la escuela seleccionada (${activeSchool.label}), faltan cargas: ${faltantes.join(', ')}.`
      );
      return res.redirect('/analista/propuestas');
    }

    const [mxgRequests, teachers, historicalRows, ruaaRows] = await Promise.all([
      MxgScheduleImport.findAll({
        where: {
          uploadId: latestMxgUpload.id,
          ...(schoolWhereMxg || {}),
          needsAdditionalHours: true,
          hrsNecesarias: { [Op.gt]: 0 },
        },
      }),
      TeacherImport.findAll({
        where: {
          uploadId: latestPxpUpload.id,
          ...(schoolWherePxp || {}),
          hrsXCub: { [Op.regexp]: '^-?[0-9]+(\\.[0-9]+)?$' },
        },
      }),
      HistoricalSubjectImport.findAll({
        where: {
          uploadId: latestHistoricoUpload.id,
          ...(schoolWhereHistorico || {}),
        },
      }),
      RuaaScheduleImport.findAll({
        where: {
          uploadId: latestRuaaUpload.id,
          ...(schoolWhereRuaa || {}),
        },
      }),
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

    const proposals = generationResult.proposals.map((proposal) => ({
      ...proposal,
      schoolKey: activeSchoolKey,
      schoolLabel: activeSchool.label,
    }));

    await sequelize.transaction(async (transaction) => {
      await SubstitutionProposal.destroy({
        where: { schoolKey: activeSchoolKey },
        transaction,
      });

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

    const reportsBySchool = req.session.proposalGenerationReports || {};
    reportsBySchool[activeSchoolKey] = {
      ...totals,
      teachersWithoutHistoricalReport: generationResult.teachersWithoutHistoricalReport,
    };
    req.session.proposalGenerationReports = reportsBySchool;
    setFlash(
      req,
      'success',
      `Escuela ${activeSchool.label}: propuestas generadas ${totals.totalPropuestas} | Horas asignadas ${totals.totalHorasAsignadas.toFixed(2)} | Conflictos turno ${totals.conflictosTurno} | Conflictos horario ${totals.conflictosHorario} | Docentes PxP sin HISTORICO ${generationResult.teachersWithoutHistoricalReport.totalTeachersWithoutHistorical}.`
    );
    return res.redirect('/analista/propuestas');
  } catch (error) {
    setFlash(req, 'error', `No se pudieron generar propuestas: ${error.message}`);
    return res.redirect('/analista/propuestas');
  }
}

async function updateProposalStatus(req, res) {
  try {
    const activeSchoolKey = String(req.session.analistaActiveSchoolKey || '').trim();
    if (!activeSchoolKey) {
      setFlash(req, 'error', 'Selecciona una escuela antes de actualizar propuestas.');
      return res.redirect('/analista/propuestas');
    }

    const proposalId = Number(req.params.id);
    const nextStatus = String(req.body.status || '').toUpperCase();
    const allowed = ['PENDIENTE', 'ACEPTADA', 'RECHAZADA'];

    if (!Number.isInteger(proposalId) || proposalId <= 0 || !allowed.includes(nextStatus)) {
      setFlash(req, 'error', 'Solicitud invalida para cambiar el estado de propuesta.');
      return res.redirect('/analista/propuestas');
    }

    const [updated] = await SubstitutionProposal.update(
      { proposalStatus: nextStatus },
      { where: { id: proposalId, schoolKey: activeSchoolKey } }
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
    const schoolOptions = await getSchoolOptionsFromMxg();
    const { activeSchoolKey, activeSchool } = resolveActiveSchool(req, schoolOptions);
    if (!activeSchoolKey || !activeSchool) {
      setFlash(req, 'error', 'No hay escuela seleccionada para exportar propuestas.');
      return res.redirect('/analista/propuestas');
    }

    const rows = await SubstitutionProposal.findAll({
      where: { schoolKey: activeSchoolKey },
      order: [['id', 'ASC']],
      limit: 20000,
    });

    const columns = [
      { key: 'id', label: 'ID de propuesta' },
      { key: 'proposalStatus', label: 'Estatus de propuesta' },
      { key: 'teacherNombre', label: 'Nombre del docente' },
      { key: 'teacherNumEmp', label: 'Numero de empleado' },
      { key: 'teacherRfc', label: 'RFC del docente' },
      { key: 'requestSubjectId', label: 'ID de materia solicitada' },
      { key: 'requestSubjectDesc', label: 'Materia solicitada' },
      { key: 'requestGroup', label: 'Grupo solicitado' },
      { key: 'requestTurno', label: 'Turno solicitado' },
      { key: 'assignedHours', label: 'Horas asignadas' },
      { key: 'requestHours', label: 'Horas requeridas' },
      { key: 'requestRemainingHours', label: 'Horas pendientes por cubrir' },
      { key: 'teacherRemainingBefore', label: 'Horas disponibles antes de asignar' },
      { key: 'teacherRemainingAfter', label: 'Horas disponibles despues de asignar' },
      { key: 'subjectMatchType', label: 'Tipo de coincidencia de materia' },
      { key: 'subjectSimilarity', label: 'Similitud de materia' },
      { key: 'hasTurnoConflict', label: 'Tiene conflicto de turno' },
      { key: 'hasHorarioConflict', label: 'Tiene conflicto de horario' },
      { key: 'conflictDetails', label: 'Detalles de conflicto' },
      { key: 'createdAt', label: 'Fecha de creacion' },
    ];

    const lines = [
      `Escuela,${csvEscape(activeSchool.label)}`,
      '',
      columns.map((col) => csvEscape(col.label)).join(','),
    ];
    for (const item of rows) {
      const values = columns.map((col) => csvEscape(item.get(col.key)));
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

async function exportLabDominanceCsv(req, res) {
  try {
    const schoolOptions = await getSchoolOptionsFromMxg();
    const { activeSchoolKey, activeSchool } = resolveActiveSchool(req, schoolOptions);
    if (!activeSchoolKey || !activeSchool) {
      setFlash(req, 'error', 'No hay escuela seleccionada para exportar el reporte.');
      return res.redirect('/analista/analitica');
    }

    const filterSemNivel = req.query.semNivel || '';
    const filterAcademia = req.query.academia || '';
    const filterAsigTipo = req.query.asigTipo || '';
    const filterModalidad = req.query.modalidad || '';
    const filterCarreraDesc = req.query.carreraDesc || '';

    const schoolWhereMxg = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantelDesc');
    const schoolWherePxp = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantel');

    const latestMxgUpload = await findLatestUploadForSchool('MXG', MxgScheduleImport, schoolWhereMxg);

    if (!latestMxgUpload) {
      setFlash(req, 'error', 'No hay carga MXG disponible para exportar.');
      return res.redirect('/analista/analitica');
    }

    const queryInterface = sequelize.getQueryInterface();
    const mxgTableColumns = await queryInterface.describeTable('mxg_schedule_imports').catch(() => ({}));
    if (!mxgTableColumns.asigTipo) {
      setFlash(req, 'error', 'La tabla MXG no tiene la columna asigTipo disponible.');
      return res.redirect('/analista/analitica');
    }

    const heatmapWhere = {
      uploadId: latestMxgUpload.id,
      ...(schoolWhereMxg || {}),
    };
    if (filterSemNivel && mxgTableColumns.semNivel) heatmapWhere.semNivel = filterSemNivel;
    if (filterAcademia) heatmapWhere.academiaDesc = filterAcademia;
    if (filterAsigTipo && mxgTableColumns.asigTipo) heatmapWhere.asigTipo = filterAsigTipo;
    if (filterModalidad) heatmapWhere.modalidad = filterModalidad;
    if (filterCarreraDesc) heatmapWhere.carreraDesc = filterCarreraDesc;

    const mxgRows = await MxgScheduleImport.findAll({
      where: heatmapWhere,
      attributes: ['numEmp', 'rfc', 'nombre', 'asigTipo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
      raw: true,
    });

    const latestPxpUpload = await findLatestUploadForSchool('PXP', TeacherImport, schoolWherePxp);

    let pxpTeacherByNumEmp = new Map();
    if (latestPxpUpload) {
      const pxpTeacherRows = await TeacherImport.findAll({
        where: {
          uploadId: latestPxpUpload.id,
          ...(schoolWherePxp || {}),
        },
        attributes: ['numEmp', 'rfc', 'nombre'],
        raw: true,
      });
      pxpTeacherByNumEmp = buildPxpTeacherLookup(pxpTeacherRows);
    }

    const report = buildLabDominanceReport(mxgRows, pxpTeacherByNumEmp);
    const appliedFilters = {
      semNivel: filterSemNivel && mxgTableColumns.semNivel ? filterSemNivel : '',
      academia: filterAcademia,
      asigTipo: filterAsigTipo && mxgTableColumns.asigTipo ? filterAsigTipo : '',
      modalidad: filterModalidad,
      carreraDesc: filterCarreraDesc,
    };

    const columns = [
      { key: 'numEmp', label: 'Numero de empleado' },
      { key: 'rfc', label: 'RFC' },
      { key: 'nombre', label: 'Nombre del docente' },
      { key: 'targetType', label: 'Tipo objetivo' },
      { key: 'laboratorioHours', label: 'Horas L-LABORATORIO' },
      { key: 'topOtherType', label: 'Otro tipo con mas horas' },
      { key: 'topOtherHours', label: 'Horas de ese otro tipo' },
      { key: 'totalHours', label: 'Total de horas' },
      { key: 'laboratorioShare', label: 'Porcentaje L-LABORATORIO' },
    ];

    const lines = [
      'Campo,Valor',
      `Escuela seleccionada,${csvEscape(activeSchool.label)}`,
      `Filtro Sem/Nivel,${csvEscape(appliedFilters.semNivel)}`,
      `Filtro academia,${csvEscape(appliedFilters.academia)}`,
      `Filtro tipo de asignatura,${csvEscape(appliedFilters.asigTipo)}`,
      `Filtro modalidad,${csvEscape(appliedFilters.modalidad)}`,
      `Filtro carrera,${csvEscape(appliedFilters.carreraDesc)}`,
      `Total de docentes,${csvEscape(report.totalDocentes)}`,
      `Tipo objetivo,${csvEscape(report.targetType)}`,
      '',
      columns.map((col) => csvEscape(col.label)).join(','),
    ];
    for (const item of report.rows) {
      const rowData = {
        numEmp: item.numEmp || '',
        rfc: item.rfc || '',
        nombre: item.nombre || '',
        targetType: report.targetType,
        laboratorioHours: Number(item.laboratorioHours || 0).toFixed(2),
        topOtherType: item.topOtherType || '',
        topOtherHours: Number(item.topOtherHours || 0).toFixed(2),
        totalHours: Number(item.totalHours || 0).toFixed(2),
        laboratorioShare: Number(item.laboratorioShare || 0).toFixed(2),
      };
      const values = columns.map((col) => csvEscape(rowData[col.key]));
      lines.push(values.join(','));
    }

    const fileName = `docentes_predominio_laboratorio_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(`\uFEFF${lines.join('\n')}`);
  } catch (error) {
    setFlash(req, 'error', `No se pudo exportar CSV del reporte de laboratorio: ${error.message}`);
    return res.redirect('/analista/analitica');
  }
}

async function exportTheoryLabCoverageCsv(req, res) {
  try {
    const schoolOptions = await getSchoolOptionsFromMxg();
    const { activeSchoolKey, activeSchool } = resolveActiveSchool(req, schoolOptions);
    if (!activeSchoolKey || !activeSchool) {
      setFlash(req, 'error', 'No hay escuela seleccionada para exportar el reporte.');
      return res.redirect('/analista/analitica');
    }

    const schoolWhereMxg = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantelDesc');
    const schoolWherePxp = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantel');

    const latestMxgUpload = await findLatestUploadForSchool('MXG', MxgScheduleImport, schoolWhereMxg);
    if (!latestMxgUpload) {
      setFlash(req, 'error', 'No hay carga MXG disponible para exportar.');
      return res.redirect('/analista/analitica');
    }

    const queryInterface = sequelize.getQueryInterface();
    const mxgTableColumns = await queryInterface.describeTable('mxg_schedule_imports').catch(() => ({}));
    if (!mxgTableColumns.asigTipo) {
      setFlash(req, 'error', 'La tabla MXG no tiene la columna asigTipo disponible.');
      return res.redirect('/analista/analitica');
    }

    const mxgRows = await MxgScheduleImport.findAll({
      where: {
        uploadId: latestMxgUpload.id,
        ...(schoolWhereMxg || {}),
      },
      attributes: [
        'plantelId',
        'plantelDesc',
        'cicloId',
        'carreraId',
        'carreraDesc',
        'planEstudio',
        'grupo',
        'turno',
        'asignaturaDesc',
        'asigTipo',
        'numEmp',
        'rfc',
        'nombre',
      ],
      raw: true,
    });

    let pxpTeacherByNumEmp = new Map();
    const latestPxpUpload = await findLatestUploadForSchool('PXP', TeacherImport, schoolWherePxp);
    if (latestPxpUpload) {
      const pxpTeacherRows = await TeacherImport.findAll({
        where: {
          uploadId: latestPxpUpload.id,
          ...(schoolWherePxp || {}),
        },
        attributes: ['numEmp', 'rfc', 'nombre'],
        raw: true,
      });
      pxpTeacherByNumEmp = buildPxpTeacherLookup(pxpTeacherRows);
    }

    const report = buildTheoryLabCoverageReport(mxgRows, pxpTeacherByNumEmp);

    const lines = [
      'Campo,Valor',
      `Escuela seleccionada,${csvEscape(activeSchool.label)}`,
      `Pares grupo-materia evaluados,${csvEscape(report.totalParesEvaluados)}`,
      `Docentes T-TEORIA sin L-LABORATORIO,${csvEscape(report.totalDocentesTeoriaSinLaboratorio)}`,
      `Grupos-materia con L-LABORATORIO y sin T-TEORIA,${csvEscape(report.totalGruposLaboratorioSinTeoria)}`,
      '',
      'Seccion,Docente,Numero de empleado,RFC,Grupo,Turno,Carrera,Materia base,Asignatura(s) teoria,Asignatura(s) laboratorio,Docente(s) laboratorio,Total docentes laboratorio',
    ];

    for (const item of report.theoryTeacherMissingLabRows) {
      lines.push([
        csvEscape('T sin L'),
        csvEscape(item.docente || ''),
        csvEscape(item.numEmp || ''),
        csvEscape(item.rfc || ''),
        csvEscape(item.grupo || ''),
        csvEscape(item.turno || ''),
        csvEscape(item.carrera || ''),
        csvEscape(item.asignaturaBase || ''),
        csvEscape(item.asignaturasTeoria || ''),
        csvEscape(item.asignaturasLaboratorio || ''),
        csvEscape(item.docentesLaboratorio || ''),
        csvEscape(''),
      ].join(','));
    }

    for (const item of report.labWithoutTheoryRows) {
      lines.push([
        csvEscape('L sin T'),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(item.grupo || ''),
        csvEscape(item.turno || ''),
        csvEscape(item.carrera || ''),
        csvEscape(item.asignaturaBase || ''),
        csvEscape(''),
        csvEscape(item.asignaturasLaboratorio || ''),
        csvEscape(item.docentesLaboratorio || ''),
        csvEscape(item.totalDocentesLaboratorio || 0),
      ].join(','));
    }

    const fileName = `cobertura_teoria_laboratorio_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(`\uFEFF${lines.join('\n')}`);
  } catch (error) {
    setFlash(req, 'error', `No se pudo exportar CSV del reporte T/L: ${error.message}`);
    return res.redirect('/analista/analitica');
  }
}

async function exportMxgNeedsHoursWithoutHistCsv(req, res) {
  try {
    const schoolOptions = await getSchoolOptionsFromMxg();
    const { activeSchoolKey, activeSchool } = resolveActiveSchool(req, schoolOptions);
    if (!activeSchoolKey || !activeSchool) {
      setFlash(req, 'error', 'No hay escuela seleccionada para exportar el reporte.');
      return res.redirect('/analista/analitica');
    }

    const schoolWhereMxg = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantelDesc');
    const schoolWherePxp = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantel');
    const schoolWhereHistorico = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantelDescripcion');

    const latestMxgUpload = await findLatestUploadForSchool('MXG', MxgScheduleImport, schoolWhereMxg);
    if (!latestMxgUpload) {
      setFlash(req, 'error', 'No hay carga MXG disponible para exportar.');
      return res.redirect('/analista/analitica');
    }

    const latestPxpUpload = await findLatestUploadForSchool('PXP', TeacherImport, schoolWherePxp);
    const latestHistoricoUpload = await findLatestUploadForSchool('HISTORICO', HistoricalSubjectImport, schoolWhereHistorico);

    let pxpTeacherByNumEmp = new Map();
    if (latestPxpUpload) {
      const pxpTeacherRows = await TeacherImport.findAll({
        where: {
          uploadId: latestPxpUpload.id,
          ...(schoolWherePxp || {}),
        },
        attributes: ['numEmp', 'rfc', 'nombre'],
        raw: true,
      });
      pxpTeacherByNumEmp = buildPxpTeacherLookup(pxpTeacherRows);
    }

    const [mxgRowsForNeedsVsHist, historicalRowsForNeedsVsHist] = await Promise.all([
      MxgScheduleImport.findAll({
        where: {
          uploadId: latestMxgUpload.id,
          ...(schoolWhereMxg || {}),
          needsAdditionalHours: true,
          hrsNecesarias: { [Op.gt]: 0 },
        },
        attributes: [
          'numEmp',
          'rfc',
          'nombre',
          'grupo',
          'turno',
          'asignaturaId',
          'asignaturaDesc',
          'academiaDesc',
          'carreraDesc',
          'hrsNecesarias',
        ],
        raw: true,
      }),
      latestHistoricoUpload
        ? HistoricalSubjectImport.findAll({
          where: {
            uploadId: latestHistoricoUpload.id,
            ...(schoolWhereHistorico || {}),
          },
          attributes: ['id', 'numEmp', 'rfc', 'asignaturaId', 'asignaturaDescripcion', 'carreraDescripcion', 'carreraId', 'cicloId'],
          raw: true,
        })
        : Promise.resolve([]),
    ]);

    const report = buildMxgNeedsHoursWithoutHistoricalMatchReport(
      mxgRowsForNeedsVsHist,
      historicalRowsForNeedsVsHist,
      pxpTeacherByNumEmp,
      { hasHistoricalSource: Boolean(latestHistoricoUpload) }
    );

    const lines = [
      'Campo,Valor',
      `Escuela seleccionada,${csvEscape(activeSchool.label)}`,
      `Existe carga HIST para la escuela,${csvEscape(report.hasHistoricalSource ? 'SI' : 'NO')}`,
      `Registros MXG evaluados (HRSNECESARIAS > 0),${csvEscape(report.totalRegistrosEvaluados)}`,
      `Docentes con HRSNECESARIAS,${csvEscape(report.totalDocentesConHrsNecesarias)}`,
      `Registros sin coincidencia en HIST,${csvEscape(report.totalRegistrosSinCoincidenciaHist)}`,
      `Docentes sin coincidencia en HIST,${csvEscape(report.totalDocentesSinCoincidenciaHist)}`,
      '',
      'Docente,Numero de empleado,RFC,Grupo,Turno,Carrera,Materia MXG,Academia MXG,HRSNECESARIAS,Registros HIST del docente,Motivo',
    ];

    for (const item of report.rows) {
      lines.push([
        csvEscape(item.docente || ''),
        csvEscape(item.numEmp || ''),
        csvEscape(item.rfc || ''),
        csvEscape(item.grupo || ''),
        csvEscape(item.turno || ''),
        csvEscape(item.carreraDesc || ''),
        csvEscape(item.asignaturaDesc || ''),
        csvEscape(item.academiaDesc || ''),
        csvEscape(Number(item.hrsNecesarias || 0).toFixed(2)),
        csvEscape(item.totalRegistrosHistDocente || 0),
        csvEscape(item.motivo || ''),
      ].join(','));
    }

    const fileName = `hrs_necesarias_sin_hist_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(`\uFEFF${lines.join('\n')}`);
  } catch (error) {
    setFlash(req, 'error', `No se pudo exportar CSV de HRSNECESARIAS sin HIST: ${error.message}`);
    return res.redirect('/analista/analitica');
  }
}

async function exportAcademiaAgeRiskCsv(req, res) {
  try {
    const schoolOptions = await getSchoolOptionsFromMxg();
    const { activeSchoolKey, activeSchool } = resolveActiveSchool(req, schoolOptions);
    if (!activeSchoolKey || !activeSchool) {
      setFlash(req, 'error', 'No hay escuela seleccionada para exportar el reporte.');
      return res.redirect('/analista/analitica');
    }

    const filterSemNivel = req.query.semNivel || '';
    const filterAcademia = req.query.academia || '';
    const filterAsigTipo = req.query.asigTipo || '';
    const filterModalidad = req.query.modalidad || '';
    const filterCarreraDesc = req.query.carreraDesc || '';

    const schoolWhereMxg = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantelDesc');
    const schoolWherePxp = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantel');

    const latestMxgUpload = await findLatestUploadForSchool('MXG', MxgScheduleImport, schoolWhereMxg);
    if (!latestMxgUpload) {
      setFlash(req, 'error', 'No hay carga MXG disponible para exportar.');
      return res.redirect('/analista/analitica');
    }

    const queryInterface = sequelize.getQueryInterface();
    const mxgTableColumns = await queryInterface.describeTable('mxg_schedule_imports').catch(() => ({}));

    const filterWhere = {
      uploadId: latestMxgUpload.id,
      ...(schoolWhereMxg || {}),
    };
    if (filterSemNivel && mxgTableColumns.semNivel) filterWhere.semNivel = filterSemNivel;
    if (filterAcademia) filterWhere.academiaDesc = filterAcademia;
    if (filterAsigTipo && mxgTableColumns.asigTipo) filterWhere.asigTipo = filterAsigTipo;
    if (filterModalidad) filterWhere.modalidad = filterModalidad;
    if (filterCarreraDesc) filterWhere.carreraDesc = filterCarreraDesc;

    const mxgRows = await MxgScheduleImport.findAll({
      where: filterWhere,
      attributes: ['numEmp', 'rfc', 'nombre', 'academiaDesc'],
      raw: true,
    });

    let pxpTeacherByNumEmp = new Map();
    const latestPxpUpload = await findLatestUploadForSchool('PXP', TeacherImport, schoolWherePxp);
    if (latestPxpUpload) {
      const pxpTeacherRows = await TeacherImport.findAll({
        where: {
          uploadId: latestPxpUpload.id,
          ...(schoolWherePxp || {}),
        },
        attributes: ['numEmp', 'rfc', 'nombre'],
        raw: true,
      });
      pxpTeacherByNumEmp = buildPxpTeacherLookup(pxpTeacherRows);
    }

    const report = buildAcademiaAgeRiskReport(mxgRows, pxpTeacherByNumEmp);
    const appliedFilters = {
      semNivel: filterSemNivel && mxgTableColumns.semNivel ? filterSemNivel : '',
      academia: filterAcademia,
      asigTipo: filterAsigTipo && mxgTableColumns.asigTipo ? filterAsigTipo : '',
      modalidad: filterModalidad,
      carreraDesc: filterCarreraDesc,
    };

    const lines = [
      'Campo,Valor',
      `Escuela seleccionada,${csvEscape(activeSchool.label)}`,
      `Filtro Sem/Nivel,${csvEscape(appliedFilters.semNivel)}`,
      `Filtro academia,${csvEscape(appliedFilters.academia)}`,
      `Filtro tipo de asignatura,${csvEscape(appliedFilters.asigTipo)}`,
      `Filtro modalidad,${csvEscape(appliedFilters.modalidad)}`,
      `Filtro carrera,${csvEscape(appliedFilters.carreraDesc)}`,
      `Edad avanzada desde,${csvEscape(report.seniorAgeThreshold)}`,
      `Relevo joven menor de,${csvEscape(report.youngAgeThreshold)}`,
      `Total academias,${csvEscape(report.totalAcademias)}`,
      `Academias con riesgo alto,${csvEscape(report.academiasConRiesgoAlto)}`,
      `Academias con riesgo medio,${csvEscape(report.academiasConRiesgoMedio)}`,
      `Docentes con edad calculada,${csvEscape(report.totalDocentesConEdad)}`,
      '',
      'Tipo,Academia,Riesgo,Docente,Numero de empleado,RFC,Edad,Total docentes,Con edad,Sin edad,Edad promedio,Menor edad,Mayor edad,Docentes edad avanzada,Docentes relevo joven',
    ];

    for (const item of report.teacherAgesForChart) {
      lines.push([
        csvEscape('DOCENTE'),
        csvEscape(item.academiaDesc || ''),
        csvEscape(''),
        csvEscape(item.docente || ''),
        csvEscape(item.numEmp || ''),
        csvEscape(item.rfc || ''),
        csvEscape(item.edad || ''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
      ].join(','));
    }

    for (const item of report.rows) {
      lines.push([
        csvEscape('ACADEMIA'),
        csvEscape(item.academiaDesc || ''),
        csvEscape(item.riskLevel || ''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(''),
        csvEscape(item.totalDocentes),
        csvEscape(item.docentesConEdad),
        csvEscape(item.docentesSinEdad),
        csvEscape(item.averageAge !== null ? item.averageAge.toFixed(1) : ''),
        csvEscape(item.youngestAge !== null ? item.youngestAge : ''),
        csvEscape(item.oldestAge !== null ? item.oldestAge : ''),
        csvEscape(item.seniorCount),
        csvEscape(item.youngCount),
      ].join(','));
    }

    const fileName = `edades_riesgo_academias_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(`\uFEFF${lines.join('\n')}`);
  } catch (error) {
    setFlash(req, 'error', `No se pudo exportar CSV de edades por academia: ${error.message}`);
    return res.redirect('/analista/analitica');
  }
}

async function exportMxgRuaaOverlapCsv(req, res) {
  try {
    const schoolOptions = await getSchoolOptionsFromMxg();
    const { activeSchoolKey, activeSchool } = resolveActiveSchool(req, schoolOptions);
    if (!activeSchoolKey || !activeSchool) {
      setFlash(req, 'error', 'No hay escuela seleccionada para exportar el reporte.');
      return res.redirect('/analista/analitica');
    }

    const schoolWhereMxg = buildSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc, 'plantelId', 'plantelDesc');
    const schoolWhereRuaa = buildRuaaSchoolWhere(activeSchool.plantelId, activeSchool.plantelDesc);

    const latestMxgUpload = await findLatestUploadForSchool('MXG', MxgScheduleImport, schoolWhereMxg);
    const latestRuaaUpload = await findLatestUploadForSchool('RUAA', RuaaScheduleImport, schoolWhereRuaa);

    if (!latestMxgUpload || !latestRuaaUpload) {
      const faltantes = [];
      if (!latestMxgUpload) faltantes.push('MXG');
      if (!latestRuaaUpload) faltantes.push('RUAA');
      setFlash(req, 'error', `Faltan cargas para generar el reporte: ${faltantes.join(', ')}.`);
      return res.redirect('/analista/analitica');
    }

    const [mxgRowsForOverlap, ruaaRowsForOverlap] = await Promise.all([
      MxgScheduleImport.findAll({
        where: {
          uploadId: latestMxgUpload.id,
          ...(schoolWhereMxg || {}),
        },
        attributes: ['numEmp', 'rfc', 'nombre', 'asignaturaDesc', 'grupo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'],
        raw: true,
      }),
      RuaaScheduleImport.findAll({
        where: {
          uploadId: latestRuaaUpload.id,
          ...(schoolWhereRuaa || {}),
        },
        attributes: ['numEmp', 'rfc', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'],
        raw: true,
      }),
    ]);

    const report = buildMxgRuaaOverlapReport(mxgRowsForOverlap, ruaaRowsForOverlap);

    const columns = [
      { key: 'numEmp', label: 'Numero de empleado' },
      { key: 'rfc', label: 'RFC' },
      { key: 'nombre', label: 'Nombre del docente' },
      { key: 'asignaturaDesc', label: 'Asignatura MXG' },
      { key: 'grupo', label: 'Grupo MXG' },
      { key: 'day', label: 'Dia' },
      { key: 'mxgRange', label: 'Horario MXG' },
      { key: 'ruaaRange', label: 'Horario RUAA' },
    ];

    const lines = [
      `Escuela,${csvEscape(activeSchool.label)}`,
      `Docentes con traslapes,${report.totalTeachersWithConflicts}`,
      '',
      columns.map((col) => csvEscape(col.label)).join(','),
    ];

    for (const teacher of report.rows) {
      for (const conflict of teacher.conflicts) {
        const rowData = {
          numEmp: teacher.numEmp || '',
          rfc: teacher.rfc || '',
          nombre: teacher.nombre || '',
          asignaturaDesc: conflict.asignaturaDesc || '',
          grupo: conflict.grupo || '',
          day: conflict.day || '',
          mxgRange: conflict.mxgRange || '',
          ruaaRange: conflict.ruaaRange || '',
        };
        lines.push(columns.map((col) => csvEscape(rowData[col.key])).join(','));
      }
    }

    const fileName = `traslapes_mxg_ruaa_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(`\uFEFF${lines.join('\n')}`);
  } catch (error) {
    setFlash(req, 'error', `No se pudo exportar CSV de traslapes MXG-RUAA: ${error.message}`);
    return res.redirect('/analista/analitica');
  }
}

async function analistaUploadPage(req, res) {
  const cargasPath = `${req.baseUrl || ''}/analista/cargas`;
  const uploadsPageSize = 20;
  const previewPageSize = 50;

  const recentUploadsResult = await getRecentUploadsPage(req.query.uploadsPage, uploadsPageSize);
  const uploadsPagination = {
    currentPage: recentUploadsResult.currentPage,
    totalPages: recentUploadsResult.totalPages,
    totalItems: recentUploadsResult.totalItems,
    startItem: recentUploadsResult.totalItems === 0 ? 0 : (recentUploadsResult.currentPage - 1) * uploadsPageSize + 1,
    endItem:
      recentUploadsResult.totalItems === 0
        ? 0
        : (recentUploadsResult.currentPage - 1) * uploadsPageSize + recentUploadsResult.items.length,
    hasPrev: recentUploadsResult.currentPage > 1,
    hasNext: recentUploadsResult.currentPage < recentUploadsResult.totalPages,
    prevHref:
      recentUploadsResult.currentPage > 1
        ? buildPaginationHref(cargasPath, req.query, 'uploadsPage', recentUploadsResult.currentPage - 1)
        : null,
    nextHref:
      recentUploadsResult.currentPage < recentUploadsResult.totalPages
        ? buildPaginationHref(cargasPath, req.query, 'uploadsPage', recentUploadsResult.currentPage + 1)
        : null,
  };

  const rawPxpReport = req.session.analistaXmlReport || null;
  const rawHistoricoReport = req.session.analistaHistoricoReport || null;
  const rawRuaaReport = req.session.analistaRuaaReport || null;
  const rawMxgReport = req.session.analistaMxgReport || null;

  const pxpPaginated = paginateCollection(
    rawPxpReport?.docentes || [],
    req.query.pxpPage,
    previewPageSize,
    'pxpPage',
    req.query,
    cargasPath
  );
  const historicoPaginated = paginateCollection(
    rawHistoricoReport?.subjects || rawHistoricoReport?.subjectsPreview || [],
    req.query.historicoPage,
    previewPageSize,
    'historicoPage',
    req.query,
    cargasPath
  );
  const ruaaClassPaginated = paginateCollection(
    rawRuaaReport?.classSchedules || rawRuaaReport?.classPreview || [],
    req.query.ruaaClassPage,
    previewPageSize,
    'ruaaClassPage',
    req.query,
    cargasPath
  );
  const ruaaActivityPaginated = paginateCollection(
    rawRuaaReport?.activitySchedules || rawRuaaReport?.activityPreview || [],
    req.query.ruaaActivityPage,
    previewPageSize,
    'ruaaActivityPage',
    req.query,
    cargasPath
  );
  const mxgPaginated = paginateCollection(
    rawMxgReport?.additionalRequests || rawMxgReport?.additionalPreview || [],
    req.query.mxgPage,
    previewPageSize,
    'mxgPage',
    req.query,
    cargasPath
  );

  const report = rawPxpReport
    ? {
      ...rawPxpReport,
      docentesPreview: pxpPaginated.items,
      previewPagination: pxpPaginated.pagination,
    }
    : null;
  const historicoReport = rawHistoricoReport
    ? {
      ...rawHistoricoReport,
      subjectsPreview: historicoPaginated.items,
      previewPagination: historicoPaginated.pagination,
      previewTruncated: historicoPaginated.pagination.totalPages > 1,
    }
    : null;
  const ruaaReport = rawRuaaReport
    ? {
      ...rawRuaaReport,
      classPreview: ruaaClassPaginated.items,
      classPreviewPagination: ruaaClassPaginated.pagination,
      activityPreview: ruaaActivityPaginated.items,
      activityPreviewPagination: ruaaActivityPaginated.pagination,
      previewTruncated:
        ruaaClassPaginated.pagination.totalPages > 1 || ruaaActivityPaginated.pagination.totalPages > 1,
    }
    : null;
  const mxgReport = rawMxgReport
    ? {
      ...rawMxgReport,
      additionalPreview: mxgPaginated.items,
      previewPagination: mxgPaginated.pagination,
      previewTruncated: mxgPaginated.pagination.totalPages > 1,
    }
    : null;

  return res.render('analista-cargas', {
    title: 'Carga de Archivos',
    report,
    historicoReport,
    ruaaReport,
    mxgReport,
    recentUploads: recentUploadsResult.items,
    uploadsPagination,
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
      subjects: historico.subjects,
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
      classSchedules: ruaa.classSchedules,
      activitySchedules: ruaa.activitySchedules,
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
          plaza: item.plaza || null,
          hrsAsig: item.hrsAsig,
          hrsFtg: item.hrsFtg,
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
      additionalRequests: mxg.additionalRequests,
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

async function aiPrompt(req, res) {
  try {
    const { prompt } = req.body || {};

    if (!prompt || String(prompt).trim().length === 0) {
      return res.status(400).json({ error: 'El prompt no puede estar vacío' });
    }

    // Build context from session data
    const uploadReport = req.session.analistaReportePxp || {};
    const mxgReport = req.session.analistaReporteMxg || {};
    const historicoReport = req.session.analistaHistoricoReport || {};
    const ruaaReport = req.session.analistaReportRuaa || {};

    const contextParts = [];

    // Add upload summary
    if (uploadReport.summary) {
      contextParts.push(`PxP: Total docentes: ${uploadReport.summary.totalDocentes}, Total plazas: ${uploadReport.summary.totalPlazas}`);
    }

    // Add MXG summary
    if (mxgReport.summary) {
      contextParts.push(`MXG: Total registros: ${mxgReport.summary.totalRegistros}, Solicitudes adicionales: ${mxgReport.summary.totalSolicitudesAdicionales}, Horas solicitadas: ${mxgReport.summary.totalHorasSolicitadas}`);
    }

    // Add HISTORICO summary
    if (historicoReport.summary) {
      contextParts.push(`HISTORICO: Total asignaturas: ${historicoReport.summary.totalAsignaturas}, Total docentes: ${historicoReport.summary.totalDocentes}`);
    }

    // Add RUAA summary
    if (ruaaReport.summary) {
      contextParts.push(`RUAA: Total clases: ${ruaaReport.summary.totalClases}, Total docentes: ${ruaaReport.summary.totalDocentes}`);
    }

    const contextStr = contextParts.join('. ');
    const systemPrompt = `Eres un asistente de análisis de datos educativos. El usuario está analizando datos de carga escolar.
${contextStr ? `Contexto disponible: ${contextStr}` : ''}
Proporciona respuestas claras y concisas sobre los datos.`;

    // Call Ollama API using native fetch
    try {
      const ollamaResponse = await fetch('http://148.204.112.157:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama3',
          prompt: prompt,
          system: systemPrompt,
          stream: false,
        }),
      });

      if (!ollamaResponse.ok) {
        const errorText = await ollamaResponse.text();
        console.error('Ollama error:', errorText);
        return res.status(500).json({ error: 'Error al consultar la IA: ' + errorText });
      }

      const data = await ollamaResponse.json();
      const aiResponse = data.response || 'Sin respuesta';

      return res.json({ response: aiResponse });
    } catch (fetchError) {
      console.error('Fetch error:', fetchError);
      return res.status(500).json({ error: `Error conectando con IA: ${fetchError.message}` });
    }
  } catch (error) {
    console.error('AI prompt error:', error);
    return res.status(500).json({ error: `Error procesando prompt: ${error.message}` });
  }
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
  exportLabDominanceCsv,
  exportTheoryLabCoverageCsv,
  exportMxgNeedsHoursWithoutHistCsv,
  exportAcademiaAgeRiskCsv,
  exportMxgRuaaOverlapCsv,
  escuelaDashboard,
  aiPrompt,
};
