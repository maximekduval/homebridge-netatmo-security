<p align="center">
<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-wordmark-logo-vertical.png" width="150">
</p>

# Homebridge Netatmo Security MK

[![npm](https://img.shields.io/npm/v/homebridge-netatmo-security-mk.svg)](https://www.npmjs.com/package/homebridge-netatmo-security-mk)

## About plugin
Exposes **Netatmo Smart Door/Window Sensors (Tags)** in Apple HomeKit. Each tag is presented as a single accessory grouping two services:

- **Contact Sensor** — open / closed state of the door or window.
- **Motion Sensor ("Vibration")** — fires when someone taps/knocks the door (Netatmo `tag_small_move`), so HomeKit can notify you. A normal open/close (`tag_big_move`) does **not** trigger it.

This is a personal fork of [Anzure/homebridge-netatmo-security](https://github.com/Anzure/homebridge-netatmo-security) (Apache-2.0), published under the `-mk` name. The main differences versus upstream:

- **OAuth2 refresh-token authentication** (Netatmo removed password login), with on-disk token persistence and rotation.
- Separate centralized poll loops for responsive door states (20 s, configurable) and lower-priority vibration events (60 s), with `homesdata` cached and exponential backoff on errors.
- Door tags exposed as Contact + Vibration; dead code removed.

### Not supported (on purpose)
- **Cameras (Welcome / Presence)** — these already have **native HomeKit support**, so there's no reason to duplicate them here.
- **Indoor Siren (NIS)** — Netatmo's API does not allow triggering the indoor siren (every state property is rejected with error 21), so it is not exposed.

## Getting started

### 1. Create a Netatmo app (Client ID / Secret)
1. Sign in to https://dev.netatmo.com (or create an account).
2. Create a new application: https://dev.netatmo.com/apps
3. Note your **Client ID** and **Client Secret**.

### 2. Generate a refresh token
Netatmo no longer supports password login, so this plugin authenticates with an OAuth2 **refresh token**:
1. On your app page, use the **Token generator**.
2. Select at least the **`read_camera`** scope (required to read the tags and their events).
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

## Notes
- Door states are polled every 20 seconds by default; expect up to ~20 s of latency (Netatmo offers no public push/webhook for these without exposing your bridge to the internet). The interval is configurable (**Poll Interval**, 15–300 s). Vibration events are fetched separately every 60 seconds.
- The default intervals use about 240 Netatmo API calls/hour (180 `homestatus` + 60 `getevents`), leaving margin below the account budget of roughly 500 calls/hour. If the logs show repeated `429`/`503` (`Netatmo error 26: User usage reached`), raise the door poll interval and check whether another integration (Home Assistant, another bridge) polls the same account.
- Door-state errors back off exponentially (up to 5 min). One or two consecutive failures are logged only at debug level; the third surfaces an error, after which repeated outage logs are throttled. A `getevents` failure only backs off vibration polling and is logged at debug level; it never prevents a successful door-state update.
- The "Vibration" motion sensor pulses for a few seconds on each detected tap so HomeKit reliably fires its notification.

## Credits
Forked from [Anzure/homebridge-netatmo-security](https://github.com/Anzure/homebridge-netatmo-security). Licensed under Apache-2.0.
