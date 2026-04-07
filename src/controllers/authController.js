const bcrypt = require('bcryptjs');
const { User } = require('../models');

function setFlash(req, type, text) {
  req.session.flash = { type, text };
}

function renderLogin(req, res) {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }

  return res.render('login', {
    title: 'Iniciar sesion',
  });
}

async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    setFlash(req, 'error', 'Completa usuario y contrasena.');
    return res.redirect('/login');
  }

  const user = await User.findOne({ where: { username } });
  if (!user || !user.active) {
    setFlash(req, 'error', 'Credenciales invalidas o usuario inactivo.');
    return res.redirect('/login');
  }

  const isValidPassword = await bcrypt.compare(password, user.passwordHash);
  if (!isValidPassword) {
    setFlash(req, 'error', 'Credenciales invalidas.');
    return res.redirect('/login');
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
  };

  return res.redirect('/dashboard');
}

function logout(req, res) {
  req.session.destroy(() => {
    res.redirect('/login');
  });
}

module.exports = {
  renderLogin,
  login,
  logout,
};
