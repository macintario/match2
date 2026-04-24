const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const MxgScheduleImport = sequelize.define(
  'MxgScheduleImport',
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
    modalidad: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    plantelId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    plantelDesc: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    cicloId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    carreraId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    carreraDesc: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    planEstudio: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    grupo: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    turno: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    asignaturaId: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    asignaturaDesc: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    academiaDesc: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    semNivel: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    asigTipo: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    numEmp: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    rfc: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    nombre: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    plaza: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    hrsAsig: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    hrsFtg: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    hrsNecesarias: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    needsAdditionalHours: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    lunes: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    martes: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    miercoles: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    jueves: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    viernes: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    sabado: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    incidencia: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
  },
  {
    tableName: 'mxg_schedule_imports',
    updatedAt: false,
  }
);

module.exports = MxgScheduleImport;
