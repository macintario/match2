const express = require('express');
const dashboardController = require('../controllers/dashboardController');
const { ensureAuth, requireRole } = require('../middlewares/auth');

const router = express.Router();

router.get('/dashboard', ensureAuth, dashboardController.redirectByRole);
router.get('/analista', ensureAuth, requireRole(['analista']), dashboardController.analistaDashboard);
router.get('/escuela', ensureAuth, requireRole(['escuela']), dashboardController.escuelaDashboard);

module.exports = router;
