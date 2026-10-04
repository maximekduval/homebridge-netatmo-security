# Changelog

## 1.0.20

- Update `axios` from 0.25 to 1.20 and `form-data` to 4.0.6, which fixes the
  known security issues of these dependencies (`npm audit` no longer reports
  any). No change in behavior.

## 1.0.19

- Keep one or two failed Netatmo status polls at debug level. An outage is
  logged as an error, along with its recovery, from the third consecutive
  failure only.

## 1.0.18

- Fetch vibration events in their own loop, every 60 s, while door states are
  still polled every 20 s by default. A `getevents` failure now only delays the
  vibration sensor and never blocks a door-state update. The default intervals
  use about 240 Netatmo API calls per hour.

## 1.0.17

First version on npm since 1.0.15. It brings the changes of 1.0.16, which was
not published on npm:

- Back off on Netatmo API errors instead of hammering the account quota:
  exponential backoff with jitter, up to 5 minutes, and at most one error line
  every 5 minutes during an outage.
- Poll every 20 s by default (about 360 calls per hour) and make the interval
  configurable with **Poll Interval** (15 to 300 s). Polls never overlap.
- Time out every Netatmo request after 10 s, including the token request.
- Show Netatmo's own error message, for example
  `error 26: User usage reached`, instead of a bare HTTP status.
- Drop the access token on a 401 only, never on a 403 or 429 quota ban.
- Recover on the next successful poll when the discovery fails at startup,
  instead of needing a restart.

## 1.0.16

- Back off on Netatmo API errors instead of hammering the account quota:
  exponential backoff with jitter, up to 5 minutes, and at most one error line
  every 5 minutes during an outage.
- Poll every 20 s by default (about 360 calls per hour) and make the interval
  configurable with **Poll Interval** (15 to 300 s). Polls never overlap.
- Time out every Netatmo request after 10 s, including the token request.
- Show Netatmo's own error message, for example
  `error 26: User usage reached`, instead of a bare HTTP status.
- Drop the access token on a 401 only, never on a 403 or 429 quota ban.
- Recover on the next successful poll when the discovery fails at startup,
  instead of needing a restart.

## 1.0.15

First version on npm since 1.0.13. It brings the change of 1.0.14, which was
not published on npm:

- Throttle the logs when Netatmo returns errors for a long time: the first
  failure, then every 20th, then the recovery.

## 1.0.14

- Throttle the logs when Netatmo returns errors for a long time: the first
  failure, then every 20th, then the recovery.

## 1.0.13

- Do not crash the poll loop when Netatmo omits the modules from `homestatus`.
  Those tags are shown as not responding instead.

## 1.0.12

- Derive the battery percentage from the millivolt level reported by the door
  tags (4000 mV is 0 %, 6000 mV is 100 %), instead of showing 100 % for any
  battery Netatmo calls "full". A low or very low battery state still raises
  the low-battery warning.

## 1.0.11

- Log the raw battery data of each door tag once at startup, to check the
  reported battery level.

## 1.0.10

First version on npm since 1.0.8. It brings the changes of 1.0.9, which was not
published on npm:

- Show a door tag that stops reporting (dead battery, out of range) as not
  responding in HomeKit, keeping its last known state, instead of "closed".
- Add a Battery service to door tags, with the low-battery warning also shown
  on the contact sensor.

## 1.0.9

- Show a door tag that stops reporting (dead battery, out of range) as not
  responding in HomeKit, keeping its last known state, instead of "closed".
- Add a Battery service to door tags, with the low-battery warning also shown
  on the contact sensor.

## 1.0.8

- Remove the indoor siren: Netatmo's API refuses to change its state, so it
  cannot be controlled from HomeKit. A siren added by an earlier version is
  removed from HomeKit.
- Update the README to the supported devices: door tags only.

## 1.0.7

- Test build published from the indoor siren branch. Use 1.0.8 or later.

## 1.0.6

- Test build published from the indoor siren branch. Use 1.0.8 or later.

## 1.0.5

- Test build published from the indoor siren branch. Use 1.0.8 or later.

## 1.0.4

- Expose a light vibration or tap on a door tag as a Vibration motion sensor,
  so HomeKit can notify when someone knocks on the door.
- Group the contact and vibration sensors of a door tag into one accessory.
- Remove unused code and dependencies.

## 1.0.3

- Poll Netatmo from one loop for all accessories instead of one timer per
  accessory, which fixes a memory leak and unhandled errors.
- Cache the home structure and poll every 15 s.

## 1.0.2

- No code change.

## 1.0.1

- First version of the `homebridge-netatmo-security-mk` fork, with OAuth2
  refresh-token authentication (Netatmo removed the password login).
