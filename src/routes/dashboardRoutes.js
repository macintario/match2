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
			text: `No se pudo cargar el archivo. Verifica que pese menos de ${maxXmlUploadMb}MB.`,
		};
		return res.redirect('/analista/cargas');
	});
}

router.get('/dashboard', ensureAuth, dashboardController.redirectByRole);
router.get('/analista', ensureAuth, requireRole(['analista']), dashboardController.analistaDashboard);
router.get('/analista/analitica', ensureAuth, requireRole(['analista']), dashboardController.analistaAnalyticsPage);
router.get('/analista/propuestas', ensureAuth, requireRole(['analista']), dashboardController.analistaProposalsPage);
router.get('/analista/cargas', ensureAuth, requireRole(['analista']), dashboardController.analistaUploadPage);
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
router.post(
	'/analista/upload-ruaa-xml',
	ensureAuth,
	requireRole(['analista']),
	handleXmlUpload,
	dashboardController.uploadAnalistaRuaaXml
);
router.post(
	'/analista/upload-mxg',
	ensureAuth,
	requireRole(['analista']),
	handleXmlUpload,
	dashboardController.uploadAnalistaMxg
);
router.post(
	'/analista/generar-propuestas',
	ensureAuth,
	requireRole(['analista']),
	dashboardController.generateAnalistaSubstitutionProposals
);
router.get(
	'/analista/propuestas/export-csv',
	ensureAuth,
	requireRole(['analista']),
	dashboardController.exportSubstitutionProposalsCsv
);
router.post(
	'/analista/propuestas/:id/estado',
	ensureAuth,
	requireRole(['analista']),
	express.urlencoded({ extended: false }),
	dashboardController.updateProposalStatus
);
router.get('/escuela', ensureAuth, requireRole(['escuela']), dashboardController.escuelaDashboard);

module.exports = router;
