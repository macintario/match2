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
    horasNomDist: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    funciones: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    cargaReg: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    desReg: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    hrsXCub: {
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
    hrsCgAb1: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    hrsCgAb2: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    hrsCgAb3: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    intHrsCarga: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    intHrsCgAb1: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    intHrsCgAb2: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    intHrsCgAb3: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    intHrsDescarga: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    intHrsDesB1: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    intHrsDesB2: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    intHrsDesB3: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    cfOtraUa: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
  },
  {
    tableName: 'teacher_imports',
    updatedAt: false,
  }
);

module.exports = TeacherImport;
