const express = require('express');
const multer = require('multer');
const dashboardController = require('../controllers/dashboardController');
const { ensureAuth, requireRole } = require('../middlewares/auth');

const router = express.Router();
const maxXmlUploadMb = Number(process.env.XML_UPLOAD_MAX_MB || 30);
const maxXmlUploadBytes = maxXmlUploadMb * 1024 * 1024;

const uploadXmlMiddleware = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: maxXmlUploadBytes },
}).single('xmlFile');

function handleXmlUpload(req, res, next) {
	uploadXmlMiddleware(req, res, (error) => {
		if (!error) {
			return next();
		}

		req.session.flash = {
			type: 'error',
			text: `No se pudo cargar el archivo XML. Verifica que pese menos de ${maxXmlUploadMb}MB.`,
		};
		return res.redirect('/analista');
	});
}

router.get('/dashboard', ensureAuth, dashboardController.redirectByRole);
router.get('/analista', ensureAuth, requireRole(['analista']), dashboardController.analistaDashboard);
router.post(
	'/analista/upload-xml',
	ensureAuth,
	requireRole(['analista']),
	handleXmlUpload,
	dashboardController.uploadAnalistaXml
);
router.post(
	'/analista/upload-historico-xml',
	ensureAuth,
	requireRole(['analista']),
	handleXmlUpload,
	dashboardController.uploadAnalistaHistoricoXml
);
router.get('/escuela', ensureAuth, requireRole(['escuela']), dashboardController.escuelaDashboard);

module.exports = router;
