module.exports = (req, res, next) => {
  if (!req.session.isLoggedIn) {
    return res.redirect('/login');
  }
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).render('403', {
      pageTitle: 'Admins only',
      path: '/403'
    });
  }
  next();
};
