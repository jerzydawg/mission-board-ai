
// Redirect old dashboard routes to /ops
app.get('/dashboard', (c) => c.redirect('/ops'));
