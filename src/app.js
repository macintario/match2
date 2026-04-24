require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');
const { DataTypes } = require('sequelize');

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const { sequelize } = require('./models');
const { normalizeMissingUsernames, ensureAdminUser } = require('./services/bootstrap');

const app = express();
const BASE_PATH = (process.env.APP_BASE_PATH || '/match2').replace(/\/$/, '');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.locals.basePath = BASE_PATH;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(BASE_PATH, express.static(path.join(__dirname, '..', 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

app.use((req, res, next) => {
  const originalRedirect = res.redirect.bind(res);
  res.redirect = (url, ...args) => {
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(BASE_PATH)) {
      return originalRedirect(`${BASE_PATH}${url}`, ...args);
    }
    return originalRedirect(url, ...args);
  };

  res.locals.basePath = BASE_PATH;
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.get('/', (req, res) => {
  return res.redirect(`${BASE_PATH}/`);
});

app.get(BASE_PATH, (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  return res.redirect('/dashboard');
});

app.get(`${BASE_PATH}/`, (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  return res.redirect('/dashboard');
});

app.use(BASE_PATH, authRoutes);
app.use(`${BASE_PATH}/admin`, adminRoutes);
app.use(BASE_PATH, dashboardRoutes);

app.use(BASE_PATH, (req, res) => {
  res.status(404).render('not-found', {
    title: 'Pagina no encontrada',
  });
});

const PORT = Number(process.env.PORT || 3000);

async function ensureSchemaCompatibility() {
  const queryInterface = sequelize.getQueryInterface();
  const tableName = 'xml_uploads';

  try {
    const columns = await queryInterface.describeTable(tableName);

    if (!columns.uploadType) {
      await queryInterface.addColumn(tableName, 'uploadType', {
        type: DataTypes.ENUM('PXP', 'HISTORICO', 'RUAA', 'MXG'),
        allowNull: false,
        defaultValue: 'PXP',
      });
    } else {
      await queryInterface.changeColumn(tableName, 'uploadType', {
        type: DataTypes.ENUM('PXP', 'HISTORICO', 'RUAA', 'MXG'),
        allowNull: false,
        defaultValue: 'PXP',
      });
    }

    if (!columns.totalAsignaturas) {
      await queryInterface.addColumn(tableName, 'totalAsignaturas', {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      });
    }

    if (!columns.totalHorarios) {
      await queryInterface.addColumn(tableName, 'totalHorarios', {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      });
    }

    if (!columns.totalActividades) {
      await queryInterface.addColumn(tableName, 'totalActividades', {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      });
    }

    if (!columns.totalSolicitudesAdicionales) {
      await queryInterface.addColumn(tableName, 'totalSolicitudesAdicionales', {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      });
    }

    // teacher_imports new columns
    const teacherColumns = await queryInterface.describeTable('teacher_imports').catch(() => null);
    if (teacherColumns) {
      const teacherNewCols = {
        horasNomDist: DataTypes.STRING(20),
        funciones: DataTypes.STRING(255),
        cargaReg: DataTypes.STRING(20),
        desReg: DataTypes.STRING(20),
        hrsXCub: DataTypes.STRING(20),
        hrsCgAb1: DataTypes.STRING(20),
        hrsCgAb2: DataTypes.STRING(20),
        hrsCgAb3: DataTypes.STRING(20),
        intHrsCarga: DataTypes.STRING(20),
        intHrsCgAb1: DataTypes.STRING(20),
        intHrsCgAb2: DataTypes.STRING(20),
        intHrsCgAb3: DataTypes.STRING(20),
        intHrsDescarga: DataTypes.STRING(20),
        intHrsDesB1: DataTypes.STRING(20),
        intHrsDesB2: DataTypes.STRING(20),
        intHrsDesB3: DataTypes.STRING(20),
        cfOtraUa: DataTypes.STRING(255),
      };
      for (const [colName, colType] of Object.entries(teacherNewCols)) {
        if (!teacherColumns[colName]) {
          await queryInterface.addColumn('teacher_imports', colName, {
            type: colType,
            allowNull: true,
            defaultValue: null,
          });
        }
      }
    }

    // position_imports new columns
    const positionColumns = await queryInterface.describeTable('position_imports').catch(() => null);
    if (positionColumns) {
      const positionNewCols = {
        status: DataTypes.STRING(10),
        motivo: DataTypes.STRING(20),
        observacion: DataTypes.STRING(255),
      };
      for (const [colName, colType] of Object.entries(positionNewCols)) {
        if (!positionColumns[colName]) {
          await queryInterface.addColumn('position_imports', colName, {
            type: colType,
            allowNull: true,
            defaultValue: null,
          });
        }
      }
    }

    // mxg_schedule_imports new columns
    const mxgColumns = await queryInterface.describeTable('mxg_schedule_imports').catch(() => null);
    if (mxgColumns) {
      const mxgNewCols = {
        semNivel: DataTypes.STRING(40),
        asigTipo: DataTypes.STRING(80),
        plaza: DataTypes.STRING(80),
        hrsFtg: DataTypes.DECIMAL(10, 2),
      };
      for (const [colName, colType] of Object.entries(mxgNewCols)) {
        if (!mxgColumns[colName]) {
          await queryInterface.addColumn('mxg_schedule_imports', colName, {
            type: colType,
            allowNull: true,
            defaultValue: null,
          });
        }
      }
    }

    const proposalColumns = await queryInterface.describeTable('substitution_proposals').catch(() => null);
    if (proposalColumns) {
      if (!proposalColumns.proposalStatus) {
        await queryInterface.addColumn('substitution_proposals', 'proposalStatus', {
          type: DataTypes.ENUM('PENDIENTE', 'ACEPTADA', 'RECHAZADA'),
          allowNull: false,
          defaultValue: 'PENDIENTE',
        });
      }

      if (!proposalColumns.schoolKey) {
        await queryInterface.addColumn('substitution_proposals', 'schoolKey', {
          type: DataTypes.STRING(220),
          allowNull: true,
          defaultValue: null,
        });
      }

      if (!proposalColumns.schoolLabel) {
        await queryInterface.addColumn('substitution_proposals', 'schoolLabel', {
          type: DataTypes.STRING(255),
          allowNull: true,
          defaultValue: null,
        });
      }
    }
  } catch (error) {
    if (error.name !== 'SequelizeDatabaseError') {
      throw error;
    }
  }
}

async function start() {
  try {
    await sequelize.authenticate();
    await sequelize.sync();
    await ensureSchemaCompatibility();
    await normalizeMissingUsernames();
    await ensureAdminUser();

    app.listen(PORT, () => {
      console.log(`Servidor iniciado en http://localhost:${PORT}${BASE_PATH}`);
    });
  } catch (error) {
    console.error('Error al iniciar la aplicacion:', error.message);
    process.exit(1);
  }
}

start();
