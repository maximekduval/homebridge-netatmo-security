/* eslint-disable max-len */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { NetatmoSecurityPlatform, NetatmoAccessory } from '../platform';

// How long the vibration MotionSensor stays "detected" after a tag_small_move,
// so HomeKit reliably fires the false->true notification edge.
const VIBRATION_PULSE_MS = 10000;

export class TagSensorAccessory implements NetatmoAccessory {
  private contactService: Service;
  private motionService: Service;
  private device: any;
  private sensorStatus = 'unknown';
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

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Netatmo-Security')
      .setCharacteristic(this.platform.Characteristic.Model, 'Tag-Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id);

    // Contact sensor: open/closed from the device status.
    this.contactService = this.accessory.getService(this.platform.Service.ContactSensor)
    || this.accessory.addService(this.platform.Service.ContactSensor);
    this.contactService.setCharacteristic(this.platform.Characteristic.Name, this.device.name);
    this.contactService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.isOpen.bind(this));

    // Vibration: a separate MotionSensor so HomeKit can notify when someone
    // taps/knocks the door (tag_small_move) without it being a normal open/close.
    this.motionService = this.accessory.getService(this.platform.Service.MotionSensor)
    || this.accessory.addService(this.platform.Service.MotionSensor, this.device.name + ' Vibration', 'vibration');
    this.motionService.setCharacteristic(this.platform.Characteristic.Name, this.device.name + ' Vibration');
    this.motionService.getCharacteristic(this.platform.Characteristic.MotionDetected)
      .onGet(() => this.motionDetected);
  }

  // Push fresh device data from the platform's single poll loop.
  update(device: any) {
    this.device = device;

    try {
      const open = device.status === 'open';
      if (device.status !== this.sensorStatus) {
        this.platform.log.info(`${this.accessory.displayName} Sensor Status: ${open} (${this.sensorStatus} -> ${device.status})`);
      }
      this.sensorStatus = device.status;
      this.contactService.updateCharacteristic(this.platform.Characteristic.ContactSensorState, this.contactState());
    } catch (error) {
      this.platform.log.error('Failed to update contact sensor status', error);
    }

    try {
      this.handleVibration(device.lastSmallMove || 0);
    } catch (error) {
      this.platform.log.error('Failed to update vibration sensor', error);
    }
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

  private contactState(): CharacteristicValue {
    const C = this.platform.Characteristic.ContactSensorState;
    return this.device?.status === 'open' ? C.CONTACT_NOT_DETECTED : C.CONTACT_DETECTED;
  }

  async isOpen(): Promise<CharacteristicValue> {
    return this.contactState();
  }

}
