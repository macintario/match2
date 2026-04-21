const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RuaaScheduleImport = sequelize.define(
  'RuaaScheduleImport',
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
    entryType: {
      type: DataTypes.ENUM('CLASE', 'ACTIVIDAD'),
      allowNull: false,
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
    plantel: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    usuarioPlantel: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    turnoDocente: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    carreraId: {
      type: DataTypes.STRING(20),
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
    grupo: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    academia: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    horas: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    actividadClave: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    actividadNombre: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    lugarActividad: {
      type: DataTypes.STRING(255),
      allowNull: true,
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
    domingo: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
  },
  {
    tableName: 'ruaa_schedule_imports',
    updatedAt: false,
  }
);

module.exports = RuaaScheduleImport;
