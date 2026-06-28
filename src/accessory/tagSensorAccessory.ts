/* eslint-disable max-len */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { NetatmoSecurityPlatform, NetatmoAccessory } from '../platform';

// How long the vibration MotionSensor stays "detected" after a tag_small_move,
// so HomeKit reliably fires the false->true notification edge.
const VIBRATION_PULSE_MS = 10000;

// A tag is only "reachable" when it reports a real door state. Anything else
// (no_news = the tag stopped reporting, e.g. dead battery or out of range;
// undefined/calibrating) means its open/closed value is unknown, so we must not
// pretend the door is closed.
const REACHABLE_STATUSES = new Set(['open', 'closed']);

// Battery percentage at or below which we flag StatusLowBattery.
const LOW_BATTERY_PERCENT = 20;

// Door tags report battery_level as a raw voltage in millivolts. We map it
// linearly to a percentage between these bounds (observed range on NACamDoorTag
// is ~4160 mV at very_low to ~5780 mV at full), which is far more granular and
// honest than the coarse battery_state enum (where "full" stays pinned at 100%).
const BATTERY_MV_EMPTY = 4000;
const BATTERY_MV_FULL = 6000;

// Netatmo's own coarse assessment; treat these as low regardless of the computed
// percentage so we never miss a low-battery warning.
const LOW_BATTERY_STATES = new Set(['low', 'very_low']);

// Last-resort mapping when only the coarse battery_state enum is available (no
// percentage and no millivolt level).
const BATTERY_STATE_PERCENT: Record<string, number> = {
  full: 100,
  high: 80,
  medium: 50,
  low: 20,
  very_low: 5,
};

export class TagSensorAccessory implements NetatmoAccessory {
  private contactService: Service;
  private motionService: Service;
  private batteryService: Service;
  private device: any;
  private sensorStatus = 'unknown';
  // Last open/closed value we actually observed while the tag was reachable. We
  // hold onto it so an unreachable tag keeps its last known state instead of
  // flipping to "closed".
  private lastKnownOpen = false;
  // Previous reachability / low-battery, so we log transitions only (the poll
  // loop runs every 15s and we don't want to spam on every tick).
  private reachable: boolean | undefined;
  private batteryLow: boolean | undefined;
  private batteryShapeWarned = false;
  // Log the raw battery-related fields once per accessory at startup, so the
  // actual Netatmo payload is visible without enabling global Homebridge debug.
  private batteryDiagLogged = false;
  // Last tag_small_move timestamp we've already reacted to. Initialized on the
  // first update so a stale event in the backlog doesn't fire a vibration alert
  // right after a restart.
  private lastSmallMoveSeen: number | undefined;
  private motionDetected = false;
  private motionTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly platform: NetatmoSecurityPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device;
    const C = this.platform.Characteristic;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Netatmo-Security')
      .setCharacteristic(C.Model, 'Tag-Sensor')
      .setCharacteristic(C.SerialNumber, this.device.id);

    // Contact sensor: open/closed from the device status.
    this.contactService = this.accessory.getService(this.platform.Service.ContactSensor)
    || this.accessory.addService(this.platform.Service.ContactSensor);
    this.contactService.setCharacteristic(C.Name, this.device.name);
    this.contactService.getCharacteristic(C.ContactSensorState)
      .onGet(this.isOpen.bind(this));
    // Surface reachability and faults on the contact sensor itself so HomeKit
    // shows "not responding" instead of a confident (and possibly wrong) state.
    this.contactService.getCharacteristic(C.StatusActive)
      .onGet(() => this.isReachable(this.device?.status));
    this.contactService.getCharacteristic(C.StatusFault)
      .onGet(() => this.faultState());
    this.contactService.getCharacteristic(C.StatusLowBattery)
      .onGet(() => this.lowBatteryState());

    // Vibration: a separate MotionSensor so HomeKit can notify when someone
    // taps/knocks the door (tag_small_move) without it being a normal open/close.
    this.motionService = this.accessory.getService(this.platform.Service.MotionSensor)
    || this.accessory.addService(this.platform.Service.MotionSensor, this.device.name + ' Vibration', 'vibration');
    this.motionService.setCharacteristic(C.Name, this.device.name + ' Vibration');
    this.motionService.getCharacteristic(C.MotionDetected)
      .onGet(() => this.motionDetected);
    this.motionService.getCharacteristic(C.StatusActive)
      .onGet(() => this.isReachable(this.device?.status));
    this.motionService.getCharacteristic(C.StatusFault)
      .onGet(() => this.faultState());

    // Battery: a dead tag is the most common reason a door tag goes silent, so
    // expose the level and a low-battery warning to make it diagnosable.
    this.batteryService = this.accessory.getService(this.platform.Service.Battery)
    || this.accessory.addService(this.platform.Service.Battery, this.device.name + ' Battery');
    this.batteryService.setCharacteristic(C.ChargingState, C.ChargingState.NOT_CHARGEABLE);
    this.batteryService.getCharacteristic(C.StatusLowBattery)
      .onGet(() => this.lowBatteryState());
    this.batteryService.getCharacteristic(C.BatteryLevel)
      .onGet(() => this.readBattery(this.device).percent ?? 100);

    // Present the two sensing services as one cohesive accessory: the door
    // contact is the primary function, the vibration motion sensor is linked.
    this.contactService.setPrimaryService(true);
    this.contactService.addLinkedService(this.motionService);
  }

  // Push fresh device data from the platform's single poll loop.
  update(device: any) {
    this.device = device;
    const C = this.platform.Characteristic;
    const reachable = this.isReachable(device.status);

    try {
      // Only trust open/closed when the tag is actually reporting.
      if (reachable) {
        this.lastKnownOpen = device.status === 'open';
      }
      if (device.status !== this.sensorStatus) {
        this.platform.log.info(`${this.accessory.displayName} Sensor Status: ${this.lastKnownOpen} (${this.sensorStatus} -> ${device.status})`);
      }
      this.sensorStatus = device.status;
      this.contactService.updateCharacteristic(C.ContactSensorState, this.contactState());
      this.contactService.updateCharacteristic(C.StatusActive, reachable);
      this.contactService.updateCharacteristic(C.StatusFault, this.faultState());
      this.motionService.updateCharacteristic(C.StatusActive, reachable);
      this.motionService.updateCharacteristic(C.StatusFault, this.faultState());
    } catch (error) {
      this.platform.log.error('Failed to update contact sensor status', error);
    }

    // Log reachability transitions only (warn when a tag goes silent).
    if (this.reachable !== undefined && this.reachable !== reachable) {
      if (reachable) {
        this.platform.log.info(`${this.accessory.displayName} is reporting again (status: ${device.status}).`);
      } else {
        this.platform.log.warn(`${this.accessory.displayName} is unreachable (status: ${device.status}) — check its battery/range. HomeKit will hold the last known state.`);
      }
    }
    this.reachable = reachable;

    try {
      this.updateBattery(device);
    } catch (error) {
      this.platform.log.error('Failed to update battery status', error);
    }

    try {
      this.handleVibration(device.lastSmallMove || 0);
    } catch (error) {
      this.platform.log.error('Failed to update vibration sensor', error);
    }
  }

  private updateBattery(device: any) {
    const C = this.platform.Characteristic;
    const battery = this.readBattery(device);

    // One-shot visibility into what Netatmo actually sends for this tag: dump
    // every battery-ish key with its raw value, plus what we end up reporting.
    if (!this.batteryDiagLogged) {
      this.batteryDiagLogged = true;
      const raw = Object.keys(device || {})
        .filter((key) => /batt/i.test(key))
        .map((key) => `${key}=${JSON.stringify(device[key])}`)
        .join(', ');
      this.platform.log.info(`${this.accessory.displayName} battery payload: {${raw || 'no battery field'}} -> reported ${battery.percent ?? 'n/a'}% (low=${battery.low})`);
    }
    const low = battery.low ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    if (battery.percent !== undefined) {
      this.batteryService.updateCharacteristic(C.BatteryLevel, battery.percent);
    }
    this.batteryService.updateCharacteristic(C.StatusLowBattery, low);
    this.contactService.updateCharacteristic(C.StatusLowBattery, low);

    if (this.batteryLow !== undefined && this.batteryLow !== battery.low) {
      if (battery.low) {
        this.platform.log.warn(`${this.accessory.displayName} battery is low${battery.percent !== undefined ? ` (${battery.percent}%)` : ''}.`);
      } else {
        this.platform.log.info(`${this.accessory.displayName} battery is back to normal.`);
      }
    }
    this.batteryLow = battery.low;
  }

  // Netatmo isn't consistent about how it reports battery across modules, so try
  // the known shapes in richest-first order: explicit percentage, then the raw
  // millivolt level (door tags), then the coarse state enum. The state enum,
  // when present, also forces a low flag regardless of the computed percentage.
  // If nothing is recognized, warn once with the available keys.
  private readBattery(device: any): { percent?: number; low: boolean } {
    const state = typeof device?.battery_state === 'string' ? device.battery_state : undefined;
    const lowByState = state !== undefined && LOW_BATTERY_STATES.has(state);

    if (typeof device?.battery_percent === 'number') {
      return { percent: device.battery_percent, low: lowByState || device.battery_percent <= LOW_BATTERY_PERCENT };
    }
    if (typeof device?.battery_level === 'number') {
      const ratio = (device.battery_level - BATTERY_MV_EMPTY) / (BATTERY_MV_FULL - BATTERY_MV_EMPTY);
      const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
      return { percent, low: lowByState || percent <= LOW_BATTERY_PERCENT };
    }
    if (state !== undefined) {
      return { percent: BATTERY_STATE_PERCENT[state], low: lowByState };
    }
    if (!this.batteryShapeWarned) {
      this.batteryShapeWarned = true;
      const keys = Object.keys(device || {}).filter((key) => /batt|rf|status/i.test(key));
      this.platform.log.warn(`${this.accessory.displayName}: no recognized battery field; available keys: [${keys.join(', ')}].`);
    }
    return { low: false };
  }

  private handleVibration(lastSmallMove: number) {
    // First update after (re)start: adopt the current value without firing, so an
    // old event still in the backlog doesn't trigger a false alert.
    if (this.lastSmallMoveSeen === undefined) {
      this.lastSmallMoveSeen = lastSmallMove;
      return;
    }
    const now = new Date().getTime() / 1000;
    const isNew = lastSmallMove > this.lastSmallMoveSeen;
    const isRecent = lastSmallMove > now - 60;
    this.lastSmallMoveSeen = lastSmallMove;
    if (isNew && isRecent) {
      this.pulseVibration();
    }
  }

  private pulseVibration() {
    this.platform.log.info(`${this.accessory.displayName} Vibration detected`);
    this.motionDetected = true;
    this.motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, true);
    if (this.motionTimer) {
      clearTimeout(this.motionTimer);
    }
    this.motionTimer = setTimeout(() => {
      this.motionDetected = false;
      this.motionService.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
    }, VIBRATION_PULSE_MS);
  }

  private isReachable(status: string | undefined): boolean {
    return REACHABLE_STATUSES.has(status as string);
  }

  private contactState(): CharacteristicValue {
    const C = this.platform.Characteristic.ContactSensorState;
    // While reachable, derive from the live status; otherwise hold the last
    // known value so a silent tag doesn't masquerade as "closed".
    const open = this.isReachable(this.device?.status)
      ? this.device?.status === 'open'
      : this.lastKnownOpen;
    return open ? C.CONTACT_NOT_DETECTED : C.CONTACT_DETECTED;
  }

  private faultState(): CharacteristicValue {
    const C = this.platform.Characteristic.StatusFault;
    return this.isReachable(this.device?.status) ? C.NO_FAULT : C.GENERAL_FAULT;
  }

  private lowBatteryState(): CharacteristicValue {
    const C = this.platform.Characteristic.StatusLowBattery;
    return this.readBattery(this.device).low ? C.BATTERY_LEVEL_LOW : C.BATTERY_LEVEL_NORMAL;
  }

  async isOpen(): Promise<CharacteristicValue> {
    return this.contactState();
  }

}
