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
 * Asegura que la tabla CATEG exista y contenga datos iniciales.
 * Se ejecuta durante el bootstrap de la aplicación.
 */
async function ensureCategoryTable(sequelize) {
  const tableName = 'CATEG';
  
  try {
    // Verificar si la tabla existe
    const existingTables = await sequelize.getQueryInterface().showAllTables();
    const normalized = (existingTables || []).map((item) => {
      if (typeof item === 'string') {
        return item.toLowerCase();
      }
      return String(item.tableName || item.TABLE_NAME || '').toLowerCase();
    });

    if (!normalized.includes(tableName.toLowerCase())) {
      // Crear la tabla con todas las columnas
      await sequelize.getQueryInterface().createTable(tableName, {
        CVE: {
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
        await sequelize.getQueryInterface().bulkInsert(tableName, categCatalog);
        console.log(`✅ ${categCatalog.length} categorías iniciales insertadas en ${tableName}.`);
      }
    } else {
      console.log(`✅ Tabla ${tableName} ya existe.`);
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
