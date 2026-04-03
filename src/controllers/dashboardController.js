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

function analistaDashboard(req, res) {
  return res.render('dashboard-analista', {
    title: 'Panel Analista',
  });
}

function escuelaDashboard(req, res) {
  return res.render('dashboard-escuela', {
    title: 'Panel Escuela',
  });
}

module.exports = {
  redirectByRole,
  analistaDashboard,
  escuelaDashboard,
};
