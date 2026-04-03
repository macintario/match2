const bcrypt = require('bcryptjs');
const { User } = require('../models');

async function ensureAdminUser() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminName = process.env.ADMIN_NAME || 'Administrador';

  if (!adminEmail || !adminPassword) {
    throw new Error('Debes definir ADMIN_EMAIL y ADMIN_PASSWORD en .env');
  }

  const existingAdmin = await User.findOne({ where: { email: adminEmail } });
  if (existingAdmin) {
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 10);
  await User.create({
    name: adminName,
    email: adminEmail,
    passwordHash,
    role: 'admin',
    active: true,
  });
}

module.exports = {
  ensureAdminUser,
};
