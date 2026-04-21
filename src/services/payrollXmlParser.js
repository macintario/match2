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
      }));

      return {
        rfc: readValue(docente.RFC),
        numEmp: readValue(docente.NUM_EMP),
        nombre: readValue(docente.NOMBRE),
        dictamen: readValue(docente.DICTAMEN),
        turno: readValue(docente.DOC_TURNO),
        horasNombramiento: readValue(docente.HRS_NOM),
        horasCarga: readValue(docente.HRSCARGA),
        horasDescarga: readValue(docente.HRSDESCARGA),
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

module.exports = {
  parsePayrollXml,
  parseHistoricoXml,
};
