<p align="center">
<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">
</p>

# Homebridge Netatmo Security MK

[![npm](https://img.shields.io/npm/v/homebridge-netatmo-security-mk.svg)](https://www.npmjs.com/package/homebridge-netatmo-security-mk)

## About plugin
Get extended HomeKit support for Netatmo Security products — exposing **door/window tags as Contact Sensors**, plus the indoor siren.

This is a personal fork of [Anzure/homebridge-netatmo-security](https://github.com/Anzure/homebridge-netatmo-security) (Apache-2.0), published under the `-mk` name. The main change versus upstream is **OAuth2 refresh-token authentication** (Netatmo removed the password login), with on-disk token persistence and rotation.

Supported or partially supported accessories:
- Netatmo Door/Window Tag → HomeKit Contact Sensor
- Netatmo Indoor Siren
- Netatmo Welcome

## Getting started

### 1. Create a Netatmo app (Client ID / Secret)
1. Sign in to https://dev.netatmo.com (or create an account).
2. Create a new application: https://dev.netatmo.com/apps
3. Note your **Client ID** and **Client Secret**.

### 2. Generate a refresh token
Netatmo no longer supports password login, so this plugin authenticates with an OAuth2 **refresh token**:
1. On your app page, use the **Token generator**.
2. Select at least the **`read_camera`** scope (required for tags and events); add **`write_camera`** if you want siren control.
3. Copy the generated **refresh token**.

The refresh token is only used on first start: the plugin then rotates and persists it automatically in the Homebridge storage directory (`netatmo-security-token.json`).

More information: https://dev.netatmo.com/apidocumentation/oauth

### 3. Install plugin
Install from npm:
```
npm install -g homebridge-netatmo-security-mk
```
or point Homebridge Config UI X to this GitHub repository.

### 4. Configure plugin
Fill in **Client ID**, **Client Secret** and **Refresh Token** in the plugin settings, then save.

### 5. Restart Homebridge
Restart Homebridge after setting up or making changes.

## Credits
Forked from [Anzure/homebridge-netatmo-security](https://github.com/Anzure/homebridge-netatmo-security). Licensed under Apache-2.0.
