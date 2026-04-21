const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const HistoricalSubjectImport = sequelize.define(
  'HistoricalSubjectImport',
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    uploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    plantelId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    plantelDescripcion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    rfc: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    numEmp: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    curp: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    nombre: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    dictamen: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    carreraId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    carreraDescripcion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    cicloId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    cicloDescripcion: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    asignaturaId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    asignaturaDescripcion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    turno: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    modalidadPresencia: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
  },
  {
    tableName: 'historical_subject_imports',
    updatedAt: false,
  }
);

module.exports = HistoricalSubjectImport;
