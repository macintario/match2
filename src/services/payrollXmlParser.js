const { XMLParser } = require('fast-xml-parser');

function toArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function readValue(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

function parsePayrollXml(xmlContent) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    parseTagValue: false,
  });

  const parsed = parser.parse(xmlContent);
  const rootKey = Object.keys(parsed || {}).find((key) => !key.startsWith('?'));
  const root = rootKey ? parsed[rootKey] : null;

  if (!root || !root.LIST_G_1) {
    throw new Error('Estructura XML no reconocida: falta LIST_G_1.');
  }

  const schools = toArray(root.LIST_G_1.G_1);
  const schoolBlocks = schools.map((school) => {
    const docentes = toArray(school?.LIST_G_DOCENTE?.G_DOCENTE).map((docente) => {
      const plazas = toArray(docente?.LIST_G_2?.G_2).map((plaza) => ({
        clave: readValue(plaza.PLAZA),
        horas: readValue(plaza.PZA_HORAS),
        numeroPlaza: readValue(plaza.PZA_NUM_PLAZA),
        fechaInicio: readValue(plaza.PZA_FEC_INI),
        fechaFin: readValue(plaza.PZA_FEC_FIN),
        status: readValue(plaza.S),
        motivo: readValue(plaza.MOT),
        observacion: readValue(plaza.OBSER),
      }));

      return {
        rfc: readValue(docente.RFC),
        numEmp: readValue(docente.NUM_EMP),
        nombre: readValue(docente.NOMBRE),
        dictamen: readValue(docente.DICTAMEN),
        turno: readValue(docente.DOC_TURNO),
        horasNombramiento: readValue(docente.HRS_NOM),
        horasNomDist: readValue(docente.HRS_NOMDIST),
        funciones: readValue(docente.FUNCIONES),
        cargaReg: readValue(docente.CARGAREG),
        desReg: readValue(docente.DESREG),
        hrsXCub: readValue(docente.HRS_X_CUB),
        horasCarga: readValue(docente.HRSCARGA),
        horasDescarga: readValue(docente.HRSDESCARGA),
        hrsCgAb1: readValue(docente.HRSCGAB1),
        hrsCgAb2: readValue(docente.HRSCGAB2),
        hrsCgAb3: readValue(docente.HRSCGAB3),
        intHrsCarga: readValue(docente.INT_HRS_CARGA),
        intHrsCgAb1: readValue(docente.INT_HRS_CGAB1),
        intHrsCgAb2: readValue(docente.INT_HRS_CGAB2),
        intHrsCgAb3: readValue(docente.INT_HRS_CGAB3),
        intHrsDescarga: readValue(docente.INT_HRS_DESCARGA),
        intHrsDesB1: readValue(docente.INT_HRS_DESB1),
        intHrsDesB2: readValue(docente.INT_HRS_DESB2),
        intHrsDesB3: readValue(docente.INT_HRS_DESB3),
        cfOtraUa: readValue(docente.CF_OTRAUA),
        plazas,
      };
    });

    return {
      cicloId: readValue(school.PLA_CIC_ID),
      plantelId: readValue(school.PLA_ID),
      plantel: readValue(school.PLA_DESCRIPCION),
      usuario: readValue(school.USUARIO),
      docentes,
    };
  });

  const docentes = schoolBlocks.flatMap((school) => school.docentes);
  const totalPlazas = docentes.reduce((acc, docente) => acc + docente.plazas.length, 0);

  return {
    schools: schoolBlocks,
    summary: {
      totalEscuelas: schoolBlocks.length,
      totalDocentes: docentes.length,
      totalPlazas,
    },
    docentes,
  };
}

function parseHistoricoXml(xmlContent) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    parseTagValue: false,
  });

  const parsed = parser.parse(xmlContent);
  const rootKey = Object.keys(parsed || {}).find((key) => !key.startsWith('?'));
  const root = rootKey ? parsed[rootKey] : null;

  if (!root || !root.LIST_G_PLANTEL) {
    throw new Error('Estructura XML no reconocida: falta LIST_G_PLANTEL.');
  }

  const schools = toArray(root.LIST_G_PLANTEL.G_PLANTEL);
  const subjects = [];

  for (const school of schools) {
    const docentes = toArray(school?.LIST_G_RFC?.G_RFC);
    for (const docente of docentes) {
      const carreras = toArray(docente?.LIST_G_1?.G_1);
      for (const carrera of carreras) {
        const asignaturas = toArray(carrera?.LIST_G_CARID?.G_CARID);
        for (const asignatura of asignaturas) {
          subjects.push({
            plantelId: readValue(school.PLANTEL),
            plantelDescripcion: readValue(school.DESCRIPCION),
            rfc: readValue(docente.RFC),
            numEmp: readValue(docente.NUMEMP),
            curp: readValue(docente.CURP),
            nombre: readValue(docente.NOMBRE),
            dictamen: readValue(docente.DICTAMEN),
            carreraId: readValue(carrera.CARID),
            carreraDescripcion: readValue(carrera.CARDESC),
            cicloId: readValue(asignatura.CIC_ID),
            cicloDescripcion: readValue(asignatura.CIC_DESCRIPCION),
            asignaturaId: readValue(asignatura.ASIID),
            asignaturaDescripcion: readValue(asignatura.ASIDESC),
            turno: readValue(asignatura.TURNO),
            modalidadPresencia: readValue(asignatura.DECODE_CAP_MOD_ID_P_PRESCENCIA),
          });
        }
      }
    }
  }

  const docentesUnicos = new Set(subjects.map((item) => `${item.rfc}|${item.numEmp}|${item.nombre}`));

  return {
    summary: {
      totalEscuelas: schools.length,
      totalDocentes: docentesUnicos.size,
      totalAsignaturas: subjects.length,
    },
    subjects,
  };
}

function parseRuaaXml(xmlContent) {
  const parser = new XMLParser({
    ignoreAttributes: true,
    trimValues: true,
    parseTagValue: false,
  });

  const parsed = parser.parse(xmlContent);
  const rootKey = Object.keys(parsed || {}).find((key) => !key.startsWith('?'));
  const root = rootKey ? parsed[rootKey] : null;

  if (!root || !root.LIST_G_DOCENTE) {
    throw new Error('Estructura XML no reconocida: falta LIST_G_DOCENTE.');
  }

  const docentes = toArray(root.LIST_G_DOCENTE.G_DOCENTE);
  const classSchedules = [];
  const activitySchedules = [];

  for (const docente of docentes) {
    const classRows = toArray(docente?.LIST_G_CARR?.G_CARR);
    for (const classRow of classRows) {
      const cargas = toArray(classRow?.LIST_G_CARGA?.G_CARGA);
      for (const carga of cargas) {
        classSchedules.push({
          numEmp: readValue(docente.NUM_EMP),
          rfc: readValue(docente.RFC),
          nombre: readValue(docente.NOMBRE),
          plantel: readValue(docente.PLANTEL),
          usuarioPlantel: readValue(docente.USUARIO),
          turnoDocente: readValue(docente.TURNO),
          carreraId: readValue(classRow.CARR),
          asignaturaId: readValue(classRow.ASIG),
          asignaturaDescripcion: readValue(classRow.ASIGNATURA),
          grupo: readValue(classRow.GRUPO),
          academia: readValue(classRow.ACADEMIA),
          horas: readValue(classRow.HRS_ASIG),
          lunes: readValue(carga.LUNES),
          martes: readValue(carga.MARTES),
          miercoles: readValue(carga.MIERCOLES),
          jueves: readValue(carga.JUEVES),
          viernes: readValue(carga.VIERNES),
          sabado: readValue(carga.SABADO),
          domingo: readValue(carga.DOMINGO),
        });
      }
    }

    const activityRows = toArray(docente?.LIST_G_DESCARGA?.G_DESCARGA);
    for (const activityRow of activityRows) {
      activitySchedules.push({
        numEmp: readValue(docente.NUM_EMP),
        rfc: readValue(docente.RFC),
        nombre: readValue(docente.NOMBRE),
        plantel: readValue(docente.PLANTEL),
        usuarioPlantel: readValue(docente.USUARIO),
        turnoDocente: readValue(docente.TURNO),
        actividadClave: readValue(activityRow.CVE_ACT),
        actividadNombre: readValue(activityRow.ACTIVIDAD),
        lugarActividad: readValue(activityRow.LUGAR),
        horas: readValue(activityRow.DES_HRS_ACTIV),
        lunes: readValue(activityRow.LUNES1),
        martes: readValue(activityRow.MARTES1),
        miercoles: readValue(activityRow.MIERCOLES1),
        jueves: readValue(activityRow.JUEVES1),
        viernes: readValue(activityRow.VIERNES1),
        sabado: readValue(activityRow.SABADO1),
        domingo: readValue(activityRow.DOMINGO1),
      });
    }
  }

  const docentesUnicos = new Set(docentes.map((item) => `${readValue(item.RFC)}|${readValue(item.NUM_EMP)}|${readValue(item.NOMBRE)}`));

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
  parsePayrollXml,
  parseHistoricoXml,
  parseRuaaXml,
};
