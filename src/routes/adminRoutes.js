const express = require('express');
const adminController = require('../controllers/adminController');
const { ensureAuth, requireRole } = require('../middlewares/auth');
const { sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

const router = express.Router();

router.use(ensureAuth, requireRole(['admin']));

// Ruta de debug para verificar estado de CATEG table
router.get('/debug/categ-status', async (req, res) => {
  try {
    const count = await sequelize.query('SELECT COUNT(*) as count FROM CATEG', {
      type: QueryTypes.SELECT,
    });
    const data = await sequelize.query('SELECT * FROM CATEG LIMIT 10', {
      type: QueryTypes.SELECT,
    });
    
    res.json({
      status: 'ok',
      tableExists: true,
      totalRecords: count[0].count,
      sampleData: data,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      tableExists: false,
    });
  }
});

router.get('/', adminController.adminHome);
router.get('/users', adminController.listUsers);
router.get('/users/new', adminController.newUserForm);
router.post('/users', adminController.createUser);
router.get('/users/:id/edit', adminController.editUserForm);
router.put('/users/:id', adminController.updateUser);

module.exports = router;
