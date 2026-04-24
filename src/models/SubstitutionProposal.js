const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SubstitutionProposal = sequelize.define(
  'SubstitutionProposal',
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    generatedByUserId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    mxgUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    pxpUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    historicoUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    ruaaUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    schoolKey: {
      type: DataTypes.STRING(220),
      allowNull: true,
    },
    schoolLabel: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    mxgScheduleImportId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    teacherImportId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    requestSubjectId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    requestSubjectDesc: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    requestGroup: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    requestTurno: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    teacherNumEmp: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    teacherRfc: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    teacherNombre: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    assignedHours: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    requestHours: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    requestRemainingHours: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    teacherRemainingBefore: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    teacherRemainingAfter: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    subjectMatchType: {
      type: DataTypes.ENUM('EXACTA', 'PARECIDA'),
      allowNull: false,
    },
    subjectSimilarity: {
      type: DataTypes.DECIMAL(5, 4),
      allowNull: false,
      defaultValue: 0,
    },
    hasTurnoConflict: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    hasHorarioConflict: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    proposalStatus: {
      type: DataTypes.ENUM('PENDIENTE', 'ACEPTADA', 'RECHAZADA'),
      allowNull: false,
      defaultValue: 'PENDIENTE',
    },
    conflictDetails: {
      type: DataTypes.STRING(600),
      allowNull: true,
    },
  },
  {
    tableName: 'substitution_proposals',
    updatedAt: false,
  }
);

module.exports = SubstitutionProposal;