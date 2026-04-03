function ensureAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  return next();
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }

    if (!allowedRoles.includes(req.session.user.role)) {
      return res.status(403).render('forbidden', {
        title: 'Acceso denegado',
      });
    }

    return next();
  };
}

module.exports = {
  ensureAuth,
  requireRole,
};
