"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const drizzle_kit_1 = require("drizzle-kit");
const config_1 = require("./src/lib/config");
const config = (0, config_1.getConfig)();
exports.default = (0, drizzle_kit_1.defineConfig)({
    dialect: 'postgresql',
    schema: './src/lib/schema.ts',
    out: './drizzle',
    dbCredentials: {
        url: config.database.postgresql_url,
    },
});
