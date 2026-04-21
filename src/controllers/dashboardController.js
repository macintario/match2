const { XMLValidator } = require('fast-xml-parser');
const { parsePayrollXml, parseHistoricoXml, parseRuaaXml } = require('../services/payrollXmlParser');
const { parseMxgWorkbook } = require('../services/mxgParser');
const {
  XmlUpload,
  TeacherImport,
  PositionImport,
  HistoricalSubjectImport,
  RuaaScheduleImport,
  MxgScheduleImport,
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

  return res.render('dashboard-analista', {
    title: 'Panel Analista',
    report,
    historicoReport,
    ruaaReport,
    mxgReport,
    recentUploads,
  });
}

async function uploadAnalistaXml(req, res) {
  try {
    if (!req.file) {
      setFlash(req, 'error', 'Debes seleccionar un archivo XML.');
      return res.redirect('/analista');
    }

    if (!/\.xml$/i.test(req.file.originalname || '')) {
      setFlash(req, 'error', 'Solo se permiten archivos con extension .xml.');
      return res.redirect('/analista');
    }

    const xmlContent = decodeXmlBuffer(req.file.buffer);
    const validXml = XMLValidator.validate(xmlContent);
    if (validXml !== true) {
      setFlash(req, 'error', 'El archivo no es un XML valido.');
      return res.redirect('/analista');
    }

    const report = parsePayrollXml(xmlContent);

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
              horasCarga: docente.horasCarga || null,
              horasDescarga: docente.horasDescarga || null,
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
    return res.redirect('/analista');
  } catch (error) {
    setFlash(req, 'error', `No se pudo procesar el XML: ${error.message}`);
    return res.redirect('/analista');
  }
}

async function uploadAnalistaHistoricoXml(req, res) {
  try {
    if (!req.file) {
      setFlash(req, 'error', 'Debes seleccionar un archivo XML.');
      return res.redirect('/analista');
    }

    if (!/\.xml$/i.test(req.file.originalname || '')) {
      setFlash(req, 'error', 'Solo se permiten archivos con extension .xml.');
      return res.redirect('/analista');
    }

    const xmlContent = decodeXmlBuffer(req.file.buffer);
    const validXml = XMLValidator.validate(xmlContent);
    if (validXml !== true) {
      setFlash(req, 'error', 'El archivo no es un XML valido.');
      return res.redirect('/analista');
    }

    const historico = parseHistoricoXml(xmlContent);

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
      subjectsPreview: historico.subjects.slice(0, 120),
      previewTruncated: historico.subjects.length > 120,
    };

    setFlash(
      req,
      'success',
      `HISTORICO procesado: ${historico.summary.totalDocentes} docentes y ${historico.summary.totalAsignaturas} asignaturas.`
    );
    return res.redirect('/analista');
  } catch (error) {
    setFlash(req, 'error', `No se pudo procesar HISTORICO.xml: ${error.message}`);
    return res.redirect('/analista');
  }
}

async function uploadAnalistaRuaaXml(req, res) {
  try {
    if (!req.file) {
      setFlash(req, 'error', 'Debes seleccionar un archivo XML.');
      return res.redirect('/analista');
    }

    if (!/\.xml$/i.test(req.file.originalname || '')) {
      setFlash(req, 'error', 'Solo se permiten archivos con extension .xml.');
      return res.redirect('/analista');
    }

    const xmlContent = decodeXmlBuffer(req.file.buffer);
    const validXml = XMLValidator.validate(xmlContent);
    if (validXml !== true) {
      setFlash(req, 'error', 'El archivo no es un XML valido.');
      return res.redirect('/analista');
    }

    const ruaa = parseRuaaXml(xmlContent);

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
    return res.redirect('/analista');
  } catch (error) {
    setFlash(req, 'error', `No se pudo procesar RUAA.xml: ${error.message}`);
    return res.redirect('/analista');
  }
}

async function uploadAnalistaMxg(req, res) {
  try {
    if (!req.file) {
      setFlash(req, 'error', 'Debes seleccionar un archivo MXG.xlsx.');
      return res.redirect('/analista');
    }

    if (!/\.xlsx$/i.test(req.file.originalname || '')) {
      setFlash(req, 'error', 'Solo se permiten archivos con extension .xlsx para MXG.');
      return res.redirect('/analista');
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
    return res.redirect('/analista');
  } catch (error) {
    setFlash(req, 'error', `No se pudo procesar MXG.xlsx: ${error.message}`);
    return res.redirect('/analista');
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
  uploadAnalistaXml,
  uploadAnalistaHistoricoXml,
  uploadAnalistaRuaaXml,
  uploadAnalistaMxg,
  escuelaDashboard,
};
