const express = require('express');
const adminController = require('../controllers/adminController');
const { ensureAuth, requireRole } = require('../middlewares/auth');

const router = express.Router();

router.use(ensureAuth, requireRole(['admin']));

router.get('/', adminController.adminHome);
router.get('/users', adminController.listUsers);
router.get('/users/new', adminController.newUserForm);
router.post('/users', adminController.createUser);
router.get('/users/:id/edit', adminController.editUserForm);
router.put('/users/:id', adminController.updateUser);

module.exports = router;
