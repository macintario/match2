'use strict';
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const Categ = sequelize.define('Categ', {
    CVE: {
      type: DataTypes.STRING(100),
      allowNull: false,
      primaryKey: true,
    },
    CATEGORIA: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    CAT_SIMPLE: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    ORD_CAT: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    CT_AV: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
  }, {
    tableName: 'CATEG',
    timestamps: false,
    underscored: false,
  });

  return Categ;
};
