const bcrypt = require('bcryptjs');
const { Op, DataTypes } = require('sequelize');
const { User } = require('../models');
const categCatalog = require('../config/categCatalog');

async function getUniqueUsername(base, currentId = null) {
  const safeBase = (base || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'user';
  let candidate = safeBase;
  let suffix = 1;

  while (true) {
    const existing = await User.findOne({ where: { username: candidate } });
    if (!existing || existing.id === currentId) {
      return candidate;
    }
    candidate = `${safeBase}${suffix}`;
    suffix += 1;
  }
}

async function normalizeMissingUsernames() {
  const users = await User.findAll({
    where: {
      [Op.or]: [{ username: null }, { username: '' }],
    },
    order: [['id', 'ASC']],
  });

  for (const user of users) {
    const fromEmail = user.email ? user.email.split('@')[0] : null;
    const base = fromEmail || user.name || `user${user.id}`;
    user.username = await getUniqueUsername(base, user.id);
    if (!user.email) {
      user.email = `${user.username}@local.invalid`;
    }
    await user.save();
  }
}

async function ensureAdminUser() {
  const adminUsername = process.env.ADMIN_USERNAME || process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminName = process.env.ADMIN_NAME || 'Administrador';

  if (!adminUsername || !adminPassword) {
    throw new Error('Debes definir ADMIN_USERNAME y ADMIN_PASSWORD en .env');
  }

  const existingAdmin = await User.findOne({ where: { username: adminUsername } });
  if (!existingAdmin && process.env.ADMIN_EMAIL) {
    const legacyAdmin = await User.findOne({ where: { email: process.env.ADMIN_EMAIL } });
    if (legacyAdmin) {
      legacyAdmin.username = await getUniqueUsername(adminUsername, legacyAdmin.id);
      if (!legacyAdmin.email) {
        legacyAdmin.email = `${legacyAdmin.username}@local.invalid`;
      }
      await legacyAdmin.save();
      return;
    }
  }

  if (existingAdmin) {
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 10);
  await User.create({
    name: adminName,
    username: adminUsername,
    email: `${adminUsername}@local.invalid`,
    passwordHash,
    role: 'admin',
    active: true,
  });
}

/**
 * Asegura que la tabla CATALOGO_CATEGORIAS exista y contenga datos iniciales.
 * Si encuentra el esquema legado (CATEG / CVE), lo migra en sitio.
 * Se ejecuta durante el bootstrap de la aplicación.
 */
async function ensureCategoryTable(sequelize) {
  const legacyTableName = 'CATEG';
  const tableName = 'CATALOGO_CATEGORIAS';
  const legacyPrimaryColumn = 'CVE';
  const primaryColumn = 'CLAVE';
  
  try {
    // Verificar si la tabla existe
    const existingTables = await sequelize.getQueryInterface().showAllTables();
    const normalized = (existingTables || []).map((item) => {
      if (typeof item === 'string') {
        return item.toLowerCase();
      }
      return String(item.tableName || item.TABLE_NAME || '').toLowerCase();
    });

    const hasLegacyTable = normalized.includes(legacyTableName.toLowerCase());
    const hasTargetTable = normalized.includes(tableName.toLowerCase());

    if (hasLegacyTable && !hasTargetTable) {
      await sequelize.query(`RENAME TABLE ${legacyTableName} TO ${tableName}`);
      console.log(`✅ Tabla ${legacyTableName} renombrada a ${tableName}.`);
    }

    if (!hasLegacyTable && !hasTargetTable) {
      // Crear la tabla con todas las columnas
      await sequelize.getQueryInterface().createTable(tableName, {
        CLAVE: {
          type: DataTypes.STRING(100),
          allowNull: false,
          primaryKey: true,
        },
        CATEGORIA: {
          type: DataTypes.STRING(255),
          allowNull: true,
        },
        CAT_SIMPLE: {
          type: DataTypes.STRING(255),
          allowNull: true,
        },
        ORD_CAT: {
          type: DataTypes.INTEGER,
          allowNull: true,
        },
        CT_AV: {
          type: DataTypes.STRING(100),
          allowNull: true,
        },
      });

      console.log(`✅ Tabla ${tableName} creada exitosamente.`);

      if (Array.isArray(categCatalog) && categCatalog.length > 0) {
        const initialRows = categCatalog.map((item) => ({
          CLAVE: item.CLAVE || item.CVE || null,
          CATEGORIA: item.CATEGORIA || null,
          CAT_SIMPLE: item.CAT_SIMPLE || null,
          ORD_CAT: item.ORD_CAT ?? null,
          CT_AV: item.CT_AV ?? null,
        }));

        await sequelize.getQueryInterface().bulkInsert(tableName, initialRows);
        console.log(`✅ ${categCatalog.length} categorías iniciales insertadas en ${tableName}.`);
      }
    } else {
      console.log(`✅ Tabla ${tableName} ya existe.`);
    }

    // Asegurar el nombre de columna nuevo (CLAVE)
    try {
      const columns = await sequelize.getQueryInterface().describeTable(tableName);
      const hasLegacyColumn = Object.prototype.hasOwnProperty.call(columns, legacyPrimaryColumn);
      const hasTargetColumn = Object.prototype.hasOwnProperty.call(columns, primaryColumn);

      if (hasLegacyColumn && !hasTargetColumn) {
        await sequelize.getQueryInterface().renameColumn(tableName, legacyPrimaryColumn, primaryColumn);
        console.log(`✅ Columna ${legacyPrimaryColumn} renombrada a ${primaryColumn} en ${tableName}.`);
      }

      // Carga inicial de respaldo cuando la tabla existe pero esta vacia.
      const [countRows] = await sequelize.query(`SELECT COUNT(*) AS total FROM ${tableName}`);
      const totalRows = Number(
        (countRows && countRows[0] && (countRows[0].total ?? countRows[0].TOTAL ?? countRows[0]['COUNT(*)'])) || 0
      );

      if (totalRows === 0 && Array.isArray(categCatalog) && categCatalog.length > 0) {
        const initialRows = categCatalog.map((item) => ({
          CLAVE: item.CLAVE || item.CVE || null,
          CATEGORIA: item.CATEGORIA || null,
          CAT_SIMPLE: item.CAT_SIMPLE || null,
          ORD_CAT: item.ORD_CAT ?? null,
          CT_AV: item.CT_AV ?? null,
        }));

        await sequelize.getQueryInterface().bulkInsert(tableName, initialRows);
        console.log(`✅ ${initialRows.length} categorias insertadas en ${tableName} (tabla vacia).`);
      }
    } catch (columnError) {
      console.error(`⚠️  Error verificando/renombrando columnas en ${tableName}:`, columnError.message);
    }
  } catch (error) {
    console.error(`⚠️  Error asegurando tabla ${tableName}:`, error.message);
    // No lanzar error para permitir que la aplicación continúe
  }
}

module.exports = {
  normalizeMissingUsernames,
  ensureAdminUser,
  ensureCategoryTable,
};
