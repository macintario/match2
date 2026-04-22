const XLSX = require('xlsx');

function asString(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function normalizeHeader(value) {
  return asString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function loadWorkbookRows(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('El archivo Excel no contiene hojas.');
  }

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    defval: '',
    raw: false,
  });

  if (rows.length === 0) {
    throw new Error('El archivo Excel no contiene datos.');
  }

  return rows;
}

function buildRowAccessor(row) {
  const normalizedMap = new Map();
  for (const [key, value] of Object.entries(row || {})) {
    normalizedMap.set(normalizeHeader(key), value);
  }

  return function getValue(...aliases) {
    for (const alias of aliases) {
      const normalizedAlias = normalizeHeader(alias);
      if (normalizedMap.has(normalizedAlias)) {
        return asString(normalizedMap.get(normalizedAlias));
      }
    }
    return '';
  };
}

function hasAnyValue(values) {
  return values.some((value) => asString(value) !== '');
}

function parsePayrollWorkbook(buffer) {
  const rows = loadWorkbookRows(buffer);
  const schoolsMap = new Map();

  for (const row of rows) {
    const getValue = buildRowAccessor(row);
    const teacher = {
      rfc: getValue('RFC', 'rfc'),
      numEmp: getValue('NUM_EMP', 'NUMEMP', 'numEmp', 'numeroEmpleado'),
      nombre: getValue('NOMBRE', 'nombre'),
      dictamen: getValue('DICTAMEN', 'dictamen'),
      turno: getValue('DOC_TURNO', 'TURNO', 'turno'),
      horasNombramiento: getValue('HRS_NOM', 'horasNombramiento'),
      horasNomDist: getValue('HRS_NOMDIST', 'horasNomDist'),
      funciones: getValue('FUNCIONES', 'funciones'),
      cargaReg: getValue('CARGAREG', 'cargaReg'),
      desReg: getValue('DESREG', 'desReg'),
      hrsXCub: getValue('HRS_X_CUB', 'hrsXCub'),
      horasCarga: getValue('HRSCARGA', 'horasCarga'),
      horasDescarga: getValue('HRSDESCARGA', 'horasDescarga'),
      hrsCgAb1: getValue('HRSCGAB1', 'hrsCgAb1'),
      hrsCgAb2: getValue('HRSCGAB2', 'hrsCgAb2'),
      hrsCgAb3: getValue('HRSCGAB3', 'hrsCgAb3'),
      intHrsCarga: getValue('INT_HRS_CARGA', 'intHrsCarga'),
      intHrsCgAb1: getValue('INT_HRS_CGAB1', 'intHrsCgAb1'),
      intHrsCgAb2: getValue('INT_HRS_CGAB2', 'intHrsCgAb2'),
      intHrsCgAb3: getValue('INT_HRS_CGAB3', 'intHrsCgAb3'),
      intHrsDescarga: getValue('INT_HRS_DESCARGA', 'intHrsDescarga'),
      intHrsDesB1: getValue('INT_HRS_DESB1', 'intHrsDesB1'),
      intHrsDesB2: getValue('INT_HRS_DESB2', 'intHrsDesB2'),
      intHrsDesB3: getValue('INT_HRS_DESB3', 'intHrsDesB3'),
      cfOtraUa: getValue('CF_OTRAUA', 'cfOtraUa'),
    };

    const schoolKey = [
      getValue('PLA_CIC_ID', 'cicloId', 'CICLO', 'ciclo'),
      getValue('PLA_ID', 'PLANTEL', 'plantelId'),
      getValue('PLA_DESCRIPCION', 'PLANTELDESC', 'plantel'),
      getValue('USUARIO', 'usuarioPlantel', 'usuario'),
    ].join('|');

    const teacherKey = [teacher.rfc, teacher.numEmp, teacher.nombre].join('|');
    if (!hasAnyValue([schoolKey, teacherKey])) {
      continue;
    }

    if (!schoolsMap.has(schoolKey)) {
      schoolsMap.set(schoolKey, {
        cicloId: getValue('PLA_CIC_ID', 'cicloId', 'CICLO', 'ciclo'),
        plantelId: getValue('PLA_ID', 'PLANTEL', 'plantelId'),
        plantel: getValue('PLA_DESCRIPCION', 'PLANTELDESC', 'plantel'),
        usuario: getValue('USUARIO', 'usuarioPlantel', 'usuario'),
        docentesMap: new Map(),
      });
    }

    const school = schoolsMap.get(schoolKey);
    if (!school.docentesMap.has(teacherKey)) {
      school.docentesMap.set(teacherKey, { ...teacher, plazas: [] });
    }

    const docente = school.docentesMap.get(teacherKey);
    const plaza = {
      clave: getValue('PLAZA', 'clavePlaza', 'clave'),
      horas: getValue('PZA_HORAS', 'horasPlaza', 'horas'),
      numeroPlaza: getValue('PZA_NUM_PLAZA', 'numeroPlaza'),
      fechaInicio: getValue('PZA_FEC_INI', 'fechaInicio'),
      fechaFin: getValue('PZA_FEC_FIN', 'fechaFin'),
      status: getValue('S', 'STATUS', 'status'),
      motivo: getValue('MOT', 'motivo'),
      observacion: getValue('OBSER', 'observacion'),
    };

    if (hasAnyValue(Object.values(plaza))) {
      docente.plazas.push(plaza);
    }
  }

  const schools = Array.from(schoolsMap.values()).map((school) => ({
    cicloId: school.cicloId,
    plantelId: school.plantelId,
    plantel: school.plantel,
    usuario: school.usuario,
    docentes: Array.from(school.docentesMap.values()),
  }));

  const docentes = schools.flatMap((school) => school.docentes);
  const totalPlazas = docentes.reduce((acc, docente) => acc + docente.plazas.length, 0);

  return {
    schools,
    summary: {
      totalEscuelas: schools.length,
      totalDocentes: docentes.length,
      totalPlazas,
    },
    docentes,
  };
}

function parseHistoricoWorkbook(buffer) {
  const rows = loadWorkbookRows(buffer);
  const subjects = rows
    .map((row) => {
      const getValue = buildRowAccessor(row);
      return {
        plantelId: getValue('PLANTEL', 'plantelId'),
        plantelDescripcion: getValue('DESCRIPCION', 'PLANTELDESC', 'plantelDescripcion'),
        rfc: getValue('RFC', 'rfc'),
        numEmp: getValue('NUMEMP', 'NUM_EMP', 'numEmp'),
        curp: getValue('CURP', 'curp'),
        nombre: getValue('NOMBRE', 'nombre'),
        dictamen: getValue('DICTAMEN', 'dictamen'),
        carreraId: getValue('CARID', 'CARRERA', 'carreraId'),
        carreraDescripcion: getValue('CARDESC', 'CARRERADESC', 'carreraDescripcion'),
        cicloId: getValue('CIC_ID', 'CICLO', 'cicloId'),
        cicloDescripcion: getValue('CIC_DESCRIPCION', 'CICLODESC', 'cicloDescripcion'),
        asignaturaId: getValue('ASIID', 'ASIGNATURA', 'asignaturaId'),
        asignaturaDescripcion: getValue('ASIDESC', 'ASIGNATURADESC', 'asignaturaDescripcion'),
        turno: getValue('TURNO', 'turno'),
        modalidadPresencia: getValue(
          'DECODE_CAP_MOD_ID_P_PRESCENCIA',
          'MODALIDADPRESENCIA',
          'modalidadPresencia'
        ),
      };
    })
    .filter((item) =>
      hasAnyValue([
        item.plantelId,
        item.rfc,
        item.numEmp,
        item.nombre,
        item.carreraId,
        item.asignaturaId,
        item.asignaturaDescripcion,
      ])
    );

  const plantelesUnicos = new Set(subjects.map((item) => `${item.plantelId}|${item.plantelDescripcion}`));
  const docentesUnicos = new Set(subjects.map((item) => `${item.rfc}|${item.numEmp}|${item.nombre}`));

  return {
    summary: {
      totalEscuelas: plantelesUnicos.size,
      totalDocentes: docentesUnicos.size,
      totalAsignaturas: subjects.length,
    },
    subjects,
  };
}

function parseRuaaWorkbook(buffer) {
  const rows = loadWorkbookRows(buffer);
  const classSchedules = [];
  const activitySchedules = [];

  for (const row of rows) {
    const getValue = buildRowAccessor(row);
    const entryType = normalizeHeader(getValue('ENTRYTYPE', 'TIPO', 'TIPOREGISTRO', 'entryType'));

    const common = {
      numEmp: getValue('NUM_EMP', 'NUMEMP', 'numEmp'),
      rfc: getValue('RFC', 'rfc'),
      nombre: getValue('NOMBRE', 'nombre'),
      plantel: getValue('PLANTEL', 'plantel'),
      usuarioPlantel: getValue('USUARIO', 'usuarioPlantel'),
      turnoDocente: getValue('TURNO', 'TURNO_DOCENTE', 'turnoDocente'),
    };

    const classRow = {
      ...common,
      carreraId: getValue('CARR', 'CARRERA', 'carreraId'),
      asignaturaId: getValue('ASIG', 'ASIGNATURAID', 'asignaturaId'),
      asignaturaDescripcion: getValue('ASIGNATURA', 'ASIGNATURADESC', 'asignaturaDescripcion'),
      grupo: getValue('GRUPO', 'grupo'),
      academia: getValue('ACADEMIA', 'academia'),
      horas: getValue('HRS_ASIG', 'HORAS', 'horas'),
      lunes: getValue('LUNES', 'lunes'),
      martes: getValue('MARTES', 'martes'),
      miercoles: getValue('MIERCOLES', 'miércoles', 'miercoles'),
      jueves: getValue('JUEVES', 'jueves'),
      viernes: getValue('VIERNES', 'viernes'),
      sabado: getValue('SABADO', 'sábado', 'sabado'),
      domingo: getValue('DOMINGO', 'domingo'),
    };

    const activityRow = {
      ...common,
      actividadClave: getValue('CVE_ACT', 'actividadClave'),
      actividadNombre: getValue('ACTIVIDAD', 'actividadNombre'),
      lugarActividad: getValue('LUGAR', 'lugarActividad'),
      horas: getValue('DES_HRS_ACTIV', 'HORAS', 'horas'),
      lunes: getValue('LUNES1', 'LUNES', 'lunes'),
      martes: getValue('MARTES1', 'MARTES', 'martes'),
      miercoles: getValue('MIERCOLES1', 'MIERCOLES', 'miércoles', 'miercoles'),
      jueves: getValue('JUEVES1', 'JUEVES', 'jueves'),
      viernes: getValue('VIERNES1', 'VIERNES', 'viernes'),
      sabado: getValue('SABADO1', 'SABADO', 'sábado', 'sabado'),
      domingo: getValue('DOMINGO1', 'DOMINGO', 'domingo'),
    };

    const looksLikeActivity =
      entryType === 'actividad' ||
      hasAnyValue([activityRow.actividadClave, activityRow.actividadNombre, activityRow.lugarActividad]);
    const looksLikeClass =
      entryType === 'clase' ||
      hasAnyValue([
        classRow.carreraId,
        classRow.asignaturaId,
        classRow.asignaturaDescripcion,
        classRow.grupo,
        classRow.academia,
      ]);

    if (looksLikeClass) {
      classSchedules.push(classRow);
    } else if (looksLikeActivity) {
      activitySchedules.push(activityRow);
    }
  }

  const docentesUnicos = new Set(
    [...classSchedules, ...activitySchedules].map((item) => `${item.rfc}|${item.numEmp}|${item.nombre}`)
  );

  return {
    summary: {
      totalDocentes: docentesUnicos.size,
      totalHorarios: classSchedules.length,
      totalActividades: activitySchedules.length,
      totalRegistros: classSchedules.length + activitySchedules.length,
    },
    classSchedules,
    activitySchedules,
  };
}

module.exports = {
  parsePayrollWorkbook,
  parseHistoricoWorkbook,
  parseRuaaWorkbook,
};