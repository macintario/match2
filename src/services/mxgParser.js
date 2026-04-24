const XLSX = require('xlsx');

function asString(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function asNumber(value) {
  if (value === undefined || value === null || value === '') {
    return 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Number.parseFloat(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseMxgWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('El archivo MXG no contiene hojas.');
  }

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    defval: '',
    raw: true,
  });

  if (rows.length === 0) {
    throw new Error('El archivo MXG no contiene datos.');
  }

  const normalizedRows = rows.map((row) => {
    const hrsNecesarias = asNumber(row.HRSNECESARIAS);
    return {
      modalidad: asString(row.MODALIDAD),
      plantelId: asString(row.PLANTEL),
      plantelDesc: asString(row.PLANTELDESC),
      cicloId: asString(row.CICLO),
      carreraId: asString(row.CARRERA),
      carreraDesc: asString(row.CARRERADESC),
      planEstudio: asString(row.PLANESTUDIO),
      grupo: asString(row.GRUPO),
      turno: asString(row.TURNO),
      asignaturaId: asString(row.ASIGNATURA),
      asignaturaDesc: asString(row.ASIGNATURADESC),
      academiaDesc: asString(row.ACADEMIADESC),
      semNivel: asString(row.SEM_NIVEL !== undefined ? row.SEM_NIVEL : row.SEMNIVEL),
      asigTipo: asString(row.ASIG_TIPO !== undefined ? row.ASIG_TIPO : row.ASIGTIPO),
      numEmp: asString(row.NUMEMP),
      rfc: asString(row.RFC2),
      nombre: asString(row.NOMBRE2),
      plaza: asString(row.PLAZA),
      hrsAsig: asNumber(row.HRSASIG),
      hrsFtg: asNumber(row.HRSFTG),
      hrsNecesarias,
      needsAdditionalHours: hrsNecesarias !== 0,
      lunes: asString(row.LUNES),
      martes: asString(row.MARTES),
      miercoles: asString(row.MIERCOLES),
      jueves: asString(row.JUEVES),
      viernes: asString(row.VIERNES),
      sabado: asString(row.SABADO),
      incidencia: asString(row.INCIDENCIA),
    };
  });

  const validRows = normalizedRows.filter(
    (item) => item.asignaturaDesc.trim() !== '' && item.academiaDesc.trim() !== ''
  );

  const docentesUnicos = new Set(
    validRows.map((item) => `${item.rfc}|${item.numEmp}|${item.nombre}`)
  );
  const additionalRequests = validRows.filter((item) => item.needsAdditionalHours);

  return {
    summary: {
      totalRegistros: validRows.length,
      totalDocentes: docentesUnicos.size,
      totalSolicitudesAdicionales: additionalRequests.length,
    },
    rows: validRows,
    additionalRequests,
  };
}

module.exports = {
  parseMxgWorkbook,
};
