const sequelize = require('../config/database');
const User = require('./User');
const XmlUpload = require('./XmlUpload');
const TeacherImport = require('./TeacherImport');
const PositionImport = require('./PositionImport');
const HistoricalSubjectImport = require('./HistoricalSubjectImport');
const RuaaScheduleImport = require('./RuaaScheduleImport');

User.hasMany(XmlUpload, { foreignKey: 'userId' });
XmlUpload.belongsTo(User, { foreignKey: 'userId' });

XmlUpload.hasMany(TeacherImport, { foreignKey: 'uploadId' });
TeacherImport.belongsTo(XmlUpload, { foreignKey: 'uploadId' });

TeacherImport.hasMany(PositionImport, { foreignKey: 'teacherImportId' });
PositionImport.belongsTo(TeacherImport, { foreignKey: 'teacherImportId' });

XmlUpload.hasMany(PositionImport, { foreignKey: 'uploadId' });
PositionImport.belongsTo(XmlUpload, { foreignKey: 'uploadId' });

XmlUpload.hasMany(HistoricalSubjectImport, { foreignKey: 'uploadId' });
HistoricalSubjectImport.belongsTo(XmlUpload, { foreignKey: 'uploadId' });

XmlUpload.hasMany(RuaaScheduleImport, { foreignKey: 'uploadId' });
RuaaScheduleImport.belongsTo(XmlUpload, { foreignKey: 'uploadId' });

module.exports = {
  sequelize,
  User,
  XmlUpload,
  TeacherImport,
  PositionImport,
  HistoricalSubjectImport,
  RuaaScheduleImport,
};
