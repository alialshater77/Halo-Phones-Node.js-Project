exports.get404 = (req, res, next) => {
  res.status(404).render('404', {
    pageTitle: 'Page Not Found',
    path: '/404',
    isAuthenticated: req.session ? req.session.isLoggedIn : false,
    isAdmin: req.user ? !!req.user.isAdmin : false
  });
};

exports.get500 = (req, res, next) => {
  res.status(500).render('500', {
    pageTitle: 'Error!',
    path: '/500',
    isAuthenticated: req.session ? req.session.isLoggedIn : false,
    isAdmin: req.user ? !!req.user.isAdmin : false,
    csrfToken: typeof req.csrfToken === 'function' ? req.csrfToken() : ''
  });
};
