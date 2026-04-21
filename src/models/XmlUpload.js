const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const XmlUpload = sequelize.define(
  'XmlUpload',
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    originalFileName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    uploadType: {
      type: DataTypes.ENUM('PXP', 'HISTORICO', 'RUAA'),
      allowNull: false,
      defaultValue: 'PXP',
    },
    totalEscuelas: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    totalDocentes: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    totalPlazas: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    totalAsignaturas: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    totalHorarios: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    totalActividades: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    uploadedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'xml_uploads',
    updatedAt: false,
  }
);

module.exports = XmlUpload;
