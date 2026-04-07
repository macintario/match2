const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { User } = require('../models');

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

module.exports = {
  normalizeMissingUsernames,
  ensureAdminUser,
};
