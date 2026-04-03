const bcrypt = require('bcryptjs');
const { User } = require('../models');

function setFlash(req, type, text) {
  req.session.flash = { type, text };
}

async function adminHome(req, res) {
  const totalUsers = await User.count();
  const totalAnalistas = await User.count({ where: { role: 'analista' } });
  const totalEscuelas = await User.count({ where: { role: 'escuela' } });

  return res.render('dashboard-admin', {
    title: 'Panel Administrador',
    stats: {
      totalUsers,
      totalAnalistas,
      totalEscuelas,
    },
  });
}

async function listUsers(req, res) {
  const users = await User.findAll({
    order: [
      ['role', 'ASC'],
      ['name', 'ASC'],
    ],
  });

  return res.render('admin-users-list', {
    title: 'Gestion de Usuarios',
    users,
  });
}

function newUserForm(req, res) {
  return res.render('admin-user-form', {
    title: 'Crear Usuario',
    formMode: 'create',
    userData: null,
  });
}

async function createUser(req, res) {
  const { name, email, password, role, active } = req.body;

  if (!name || !email || !password || !role) {
    setFlash(req, 'error', 'Todos los campos obligatorios deben completarse.');
    return res.redirect('/admin/users/new');
  }

  if (!['analista', 'escuela'].includes(role)) {
    setFlash(req, 'error', 'Rol invalido.');
    return res.redirect('/admin/users/new');
  }

  const existing = await User.findOne({ where: { email } });
  if (existing) {
    setFlash(req, 'error', 'El correo ya esta registrado.');
    return res.redirect('/admin/users/new');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await User.create({
    name,
    email,
    passwordHash,
    role,
    active: active === 'on',
  });

  setFlash(req, 'success', 'Usuario creado correctamente.');
  return res.redirect('/admin/users');
}

async function editUserForm(req, res) {
  const user = await User.findByPk(req.params.id);
  if (!user) {
    return res.status(404).render('not-found', { title: 'Usuario no encontrado' });
  }

  return res.render('admin-user-form', {
    title: 'Editar Usuario',
    formMode: 'edit',
    userData: user,
  });
}

async function updateUser(req, res) {
  const user = await User.findByPk(req.params.id);
  if (!user) {
    return res.status(404).render('not-found', { title: 'Usuario no encontrado' });
  }

  const { name, email, password, role, active } = req.body;

  if (!name || !email) {
    setFlash(req, 'error', 'Nombre y correo son obligatorios.');
    return res.redirect(`/admin/users/${user.id}/edit`);
  }

  const requestedRole = role || user.role;

  if (user.role !== 'admin' && !['analista', 'escuela'].includes(requestedRole)) {
    setFlash(req, 'error', 'Rol invalido.');
    return res.redirect(`/admin/users/${user.id}/edit`);
  }

  const existing = await User.findOne({ where: { email } });
  if (existing && existing.id !== user.id) {
    setFlash(req, 'error', 'El correo ya esta registrado por otro usuario.');
    return res.redirect(`/admin/users/${user.id}/edit`);
  }

  user.name = name;
  user.email = email;
  user.role = user.role === 'admin' ? 'admin' : requestedRole;
  user.active = user.role === 'admin' ? true : active === 'on';

  if (password && password.trim()) {
    user.passwordHash = await bcrypt.hash(password, 10);
  }

  await user.save();
  setFlash(req, 'success', 'Usuario actualizado correctamente.');
  return res.redirect('/admin/users');
}

module.exports = {
  adminHome,
  listUsers,
  newUserForm,
  createUser,
  editUserForm,
  updateUser,
};
