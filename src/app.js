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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.get('/', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  return res.redirect('/dashboard');
});

app.use(authRoutes);
app.use('/admin', adminRoutes);
app.use(dashboardRoutes);

app.use((req, res) => {
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
        type: DataTypes.ENUM('PXP', 'HISTORICO', 'RUAA'),
        allowNull: false,
        defaultValue: 'PXP',
      });
    } else {
      await queryInterface.changeColumn(tableName, 'uploadType', {
        type: DataTypes.ENUM('PXP', 'HISTORICO', 'RUAA'),
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
      console.log(`Servidor iniciado en http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Error al iniciar la aplicacion:', error.message);
    process.exit(1);
  }
}

start();
