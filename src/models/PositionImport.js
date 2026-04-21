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
  },
  {
    tableName: 'position_imports',
    updatedAt: false,
  }
);

module.exports = PositionImport;
