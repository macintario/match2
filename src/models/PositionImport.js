const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PositionImport = sequelize.define(
  'PositionImport',
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
    teacherImportId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    clave: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    horas: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    numeroPlaza: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    fechaInicio: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    fechaFin: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    motivo: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    observacion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
  },
  {
    tableName: 'position_imports',
    updatedAt: false,
  }
);

module.exports = PositionImport;
