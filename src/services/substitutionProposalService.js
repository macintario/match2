function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function minutesFromToken(token) {
  const clean = String(token || '').trim();
  if (!clean) {
    return null;
  }

  if (/^\d{1,2}:\d{2}$/.test(clean)) {
    const [h, m] = clean.split(':').map(Number);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      return h * 60 + m;
    }
    return null;
  }

  if (/^\d{1,2}$/.test(clean)) {
    const h = Number(clean);
    if (h >= 0 && h < 24) {
      return h * 60;
    }
    return null;
  }

  if (/^\d{3,4}$/.test(clean)) {
    const h = Number(clean.length === 3 ? clean.slice(0, 1) : clean.slice(0, 2));
    const m = Number(clean.length === 3 ? clean.slice(1) : clean.slice(2));
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      return h * 60 + m;
    }
  }

  return null;
}

function parseDayRanges(value) {
  const text = String(value || '').trim();
  if (!text) {
    return [];
  }

  const ranges = [];
  const regex = /(\d{1,2}:\d{2}|\d{1,2}|\d{3,4})\s*[-a]\s*(\d{1,2}:\d{2}|\d{1,2}|\d{3,4})/gi;
  let match = regex.exec(text);
  while (match) {
    const start = minutesFromToken(match[1]);
    const end = minutesFromToken(match[2]);
    if (start !== null && end !== null && end > start) {
      ranges.push({ start, end, raw: match[0] });
    }
    match = regex.exec(text);
  }

  return ranges;
}

function rangesOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function splitTokens(text) {
  return new Set(normalizeText(text).split(' ').filter(Boolean));
}

function similarityByTokens(a, b) {
  const sa = splitTokens(a);
  const sb = splitTokens(b);
  if (!sa.size || !sb.size) {
    return 0;
  }
  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) {
      inter += 1;
    }
  }
  const union = new Set([...sa, ...sb]).size;
  return union ? inter / union : 0;
}

function normalizeTurno(value) {
  const t = normalizeText(value);
  if (!t) {
    return '';
  }

  if (t === 'm' || t.includes('matutino')) {
    return 'M';
  }

  if (t === 'v' || t.includes('vespertino')) {
    return 'V';
  }

  if (t === 'x' || t.includes('mixto')) {
    return 'X';
  }

  return '';
}

function isTurnoConflict(requestTurno, teacherTurno) {
  const req = normalizeTurno(requestTurno);
  const tea = normalizeTurno(teacherTurno);
  if (!req || !tea) {
    return false;
  }

  if (tea === 'X' || req === 'X') {
    return false;
  }

  return req !== tea;
}

function buildTeacherHorarioIndex(ruaaRows) {
  const days = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
  const byTeacher = new Map();

  for (const row of ruaaRows) {
    const teacherKey = `${row.numEmp || ''}|${row.rfc || ''}`;
    if (!byTeacher.has(teacherKey)) {
      byTeacher.set(teacherKey, {
        teacherKey,
        dayRanges: {
          lunes: [],
          martes: [],
          miercoles: [],
          jueves: [],
          viernes: [],
          sabado: [],
          domingo: [],
        },
      });
    }
    const teacher = byTeacher.get(teacherKey);
    for (const day of days) {
      const parsed = parseDayRanges(row[day]);
      if (parsed.length > 0) {
        teacher.dayRanges[day].push(...parsed);
      }
    }
  }

  return byTeacher;
}

function evaluateTeacherMatch(request, teacher, historicalByTeacher, teacherRuaa, proposedRuaa) {
  const reqSubjectId = String(request.asignaturaId || '').trim();
  const reqSubjectDesc = String(request.asignaturaDesc || '').trim();
  const teacherKey = `${teacher.numEmp || ''}|${teacher.rfc || ''}`;

  const history = historicalByTeacher.get(teacherKey) || [];
  let bestSimilarity = 0;
  let matchType = null;

  for (const h of history) {
    const histSubjectId = String(h.asignaturaId || '').trim();
    const histSubjectDesc = String(h.asignaturaDescripcion || '').trim();
    if (reqSubjectId && histSubjectId && reqSubjectId === histSubjectId) {
      return { matchType: 'EXACTA', similarity: 1 };
    }

    const sim = similarityByTokens(reqSubjectDesc, histSubjectDesc);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
    }
  }

  if (bestSimilarity >= 0.45) {
    matchType = 'PARECIDA';
  }

  if (!matchType) {
    return null;
  }

  const turnoConflict = isTurnoConflict(request.turno, teacher.turno);

  const reqDays = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const horarioConflictDetails = [];
  const allTeacherRanges = teacherRuaa?.dayRanges || {
    lunes: [],
    martes: [],
    miercoles: [],
    jueves: [],
    viernes: [],
    sabado: [],
    domingo: [],
  };
  const allProposedRanges = proposedRuaa || {
    lunes: [],
    martes: [],
    miercoles: [],
    jueves: [],
    viernes: [],
    sabado: [],
    domingo: [],
  };

  for (const day of reqDays) {
    const reqRanges = parseDayRanges(request[day]);
    if (!reqRanges.length) {
      continue;
    }

    for (const rr of reqRanges) {
      const conflictsWithRuaa = allTeacherRanges[day].some((tr) => rangesOverlap(rr, tr));
      const conflictsWithProposed = allProposedRanges[day].some((tr) => rangesOverlap(rr, tr));

      if (conflictsWithRuaa || conflictsWithProposed) {
        horarioConflictDetails.push(`${day}:${rr.raw}`);
      }
    }
  }

  return {
    matchType,
    similarity: matchType === 'EXACTA' ? 1 : bestSimilarity,
    hasTurnoConflict: turnoConflict,
    hasHorarioConflict: horarioConflictDetails.length > 0,
    conflictDetails: [
      turnoConflict ? `Conflicto de turno (solicitud=${request.turno || '-'}, docente=${teacher.turno || '-'})` : null,
      horarioConflictDetails.length
        ? `Conflicto de horario en ${horarioConflictDetails.join(', ')}`
        : null,
    ]
      .filter(Boolean)
      .join(' | '),
  };
}

function cloneEmptyWeekSlots() {
  return {
    lunes: [],
    martes: [],
    miercoles: [],
    jueves: [],
    viernes: [],
    sabado: [],
    domingo: [],
  };
}

function addRequestSlotsToTeacherProposed(proposedSlots, request) {
  const days = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  for (const day of days) {
    proposedSlots[day].push(...parseDayRanges(request[day]));
  }
}

function buildTeachersWithoutHistoricalReport(teachers, historicalByTeacher) {
  const rows = teachers
    .filter((teacher) => {
      const teacherKey = `${teacher.numEmp || ''}|${teacher.rfc || ''}`;
      return !historicalByTeacher.has(teacherKey);
    })
    .map((teacher) => ({
      teacherImportId: teacher.id,
      numEmp: teacher.numEmp || null,
      rfc: teacher.rfc || null,
      nombre: teacher.nombre || null,
      plantelId: teacher.plantelId || null,
      plantel: teacher.plantel || null,
      turno: teacher.turno || null,
      hrsXCub: toNumber(teacher.hrsXCub),
      reason: 'Sin coincidencias en HISTORICO para este docente.',
    }))
    .sort((a, b) => {
      if ((b.hrsXCub || 0) !== (a.hrsXCub || 0)) {
        return (b.hrsXCub || 0) - (a.hrsXCub || 0);
      }
      return String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es', {
        sensitivity: 'base',
      });
    });

  return {
    totalTeachersWithoutHistorical: rows.length,
    totalHoursWithoutHistorical: rows.reduce((acc, row) => acc + toNumber(row.hrsXCub), 0),
    rows,
  };
}

function generateSubstitutionProposals({
  mxgRequests,
  teachers,
  historicalRows,
  ruaaRows,
  uploadIds,
  generatedByUserId,
}) {
  const historicalByTeacher = new Map();
  for (const row of historicalRows) {
    const key = `${row.numEmp || ''}|${row.rfc || ''}`;
    if (!historicalByTeacher.has(key)) {
      historicalByTeacher.set(key, []);
    }
    historicalByTeacher.get(key).push(row);
  }

  const teacherRuaaIndex = buildTeacherHorarioIndex(ruaaRows);
  const teachersWithoutHistoricalReport = buildTeachersWithoutHistoricalReport(
    teachers,
    historicalByTeacher
  );

  const teacherState = teachers.map((teacher) => ({
    teacher,
    teacherKey: `${teacher.numEmp || ''}|${teacher.rfc || ''}`,
    remainingHours: toNumber(teacher.hrsXCub),
    proposedSlots: cloneEmptyWeekSlots(),
  }));

  const proposals = [];

  for (const request of mxgRequests) {
    let missing = toNumber(request.hrsNecesarias);
    if (missing <= 0) {
      continue;
    }

    const candidates = teacherState
      .filter((state) => state.remainingHours > 0)
      .filter((state) => !request.plantelId || !state.teacher.plantelId || request.plantelId === state.teacher.plantelId)
      .map((state) => {
        const evalResult = evaluateTeacherMatch(
          request,
          state.teacher,
          historicalByTeacher,
          teacherRuaaIndex.get(state.teacherKey),
          state.proposedSlots
        );
        if (!evalResult) {
          return null;
        }
        return {
          state,
          ...evalResult,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const rankA = a.matchType === 'EXACTA' ? 2 : 1;
        const rankB = b.matchType === 'EXACTA' ? 2 : 1;
        if (rankA !== rankB) {
          return rankB - rankA;
        }
        if (a.similarity !== b.similarity) {
          return b.similarity - a.similarity;
        }
        const conflictA = Number(a.hasTurnoConflict || a.hasHorarioConflict);
        const conflictB = Number(b.hasTurnoConflict || b.hasHorarioConflict);
        if (conflictA !== conflictB) {
          return conflictA - conflictB;
        }
        return b.state.remainingHours - a.state.remainingHours;
      });

    for (const candidate of candidates) {
      if (missing <= 0) {
        break;
      }
      if (candidate.state.remainingHours <= 0) {
        continue;
      }

      const before = candidate.state.remainingHours;
      const assigned = Math.min(before, missing);
      candidate.state.remainingHours = Number((before - assigned).toFixed(2));
      missing = Number((missing - assigned).toFixed(2));

      proposals.push({
        generatedByUserId,
        mxgUploadId: uploadIds.mxgUploadId,
        pxpUploadId: uploadIds.pxpUploadId,
        historicoUploadId: uploadIds.historicoUploadId,
        ruaaUploadId: uploadIds.ruaaUploadId,
        mxgScheduleImportId: request.id,
        teacherImportId: candidate.state.teacher.id,
        requestSubjectId: request.asignaturaId || null,
        requestSubjectDesc: request.asignaturaDesc || null,
        requestGroup: request.grupo || null,
        requestTurno: request.turno || null,
        teacherNumEmp: candidate.state.teacher.numEmp || null,
        teacherRfc: candidate.state.teacher.rfc || null,
        teacherNombre: candidate.state.teacher.nombre || null,
        assignedHours: assigned,
        requestHours: toNumber(request.hrsNecesarias),
        requestRemainingHours: missing,
        teacherRemainingBefore: before,
        teacherRemainingAfter: candidate.state.remainingHours,
        subjectMatchType: candidate.matchType,
        subjectSimilarity: candidate.similarity,
        hasTurnoConflict: candidate.hasTurnoConflict,
        hasHorarioConflict: candidate.hasHorarioConflict,
        conflictDetails: candidate.conflictDetails || null,
      });

      addRequestSlotsToTeacherProposed(candidate.state.proposedSlots, request);
    }
  }

  return {
    proposals,
    teachersWithoutHistoricalReport,
  };
}

function buildMxgRuaaOverlapReport(mxgRows, ruaaRows) {
  const days = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const ruaaIndex = buildTeacherHorarioIndex(ruaaRows);
  const conflictsByTeacher = new Map();

  for (const mxgRow of mxgRows) {
    const numEmp = String(mxgRow.numEmp || '').trim();
    const rfc = String(mxgRow.rfc || '').trim();
    if (!numEmp && !rfc) {
      continue;
    }

    const teacherKey = `${numEmp}|${rfc}`;
    const ruaaTeacher = ruaaIndex.get(teacherKey);
    if (!ruaaTeacher) {
      continue;
    }

    for (const day of days) {
      const mxgRanges = parseDayRanges(mxgRow[day]);
      if (!mxgRanges.length) {
        continue;
      }

      const ruaaRanges = ruaaTeacher.dayRanges[day] || [];
      if (!ruaaRanges.length) {
        continue;
      }

      for (const mr of mxgRanges) {
        for (const rr of ruaaRanges) {
          if (rangesOverlap(mr, rr)) {
            if (!conflictsByTeacher.has(teacherKey)) {
              conflictsByTeacher.set(teacherKey, {
                numEmp: numEmp || null,
                rfc: rfc || null,
                nombre: String(mxgRow.nombre || '').trim() || null,
                conflicts: [],
              });
            }
            conflictsByTeacher.get(teacherKey).conflicts.push({
              asignaturaDesc: mxgRow.asignaturaDesc || null,
              grupo: mxgRow.grupo || null,
              day,
              mxgRange: mr.raw,
              ruaaRange: rr.raw,
            });
          }
        }
      }
    }
  }

  const rows = Array.from(conflictsByTeacher.values()).sort((a, b) =>
    String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es', { sensitivity: 'base' })
  );

  return {
    totalTeachersWithConflicts: rows.length,
    rows,
  };
}

module.exports = {
  generateSubstitutionProposals,
  buildMxgRuaaOverlapReport,
};