export const PLATFORM_NAME = 'netatmo-security';
// MUST equal the "name" in package.json. With the 2-arg registerPlatform(),
// Homebridge stamps registered accessories with this plugin name; a mismatch makes
// it re-create every accessory on each restart (see homebridge-tahoma bug C6).
export const PLUGIN_NAME = 'homebridge-netatmo-security-mk';