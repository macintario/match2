const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const TeacherImport = sequelize.define(
  'TeacherImport',
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
    cicloId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    plantelId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    plantel: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    usuarioPlantel: {
      type: DataTypes.STRING(120),
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
    nombre: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    dictamen: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    turno: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    horasNombramiento: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    horasCarga: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    horasDescarga: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
  },
  {
    tableName: 'teacher_imports',
    updatedAt: false,
  }
);

module.exports = TeacherImport;
