/* eslint-disable max-len */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { NetatmoSecurityPlatform, NetatmoAccessory } from '../platform';

export class TagSensorAccessory implements NetatmoAccessory {
  private service: Service;
  private device: any;
  private state = {
    SensorStatus: 'unknown',
    TamperStatus: 0,
  };

  constructor(
    private readonly platform: NetatmoSecurityPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Netatmo-Security')
      .setCharacteristic(this.platform.Characteristic.Model, 'Tag-Sensor')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id);

    this.service = this.accessory.getService(this.platform.Service.ContactSensor)
    || this.accessory.addService(this.platform.Service.ContactSensor);

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.isOpen.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.StatusTampered)
      .onGet(this.isTampered.bind(this));
  }

  // Push fresh device data from the platform's single poll loop.
  update(device: any) {
    this.device = device;
    const C = this.platform.Characteristic;

    try {
      const open = device.status === 'open';
      if (device.status !== this.state.SensorStatus) {
        this.platform.log.info(`${this.accessory.displayName} Sensor Status: ${open} (${this.state.SensorStatus} -> ${device.status})`);
      }
      this.state.SensorStatus = device.status;
      this.service.updateCharacteristic(C.ContactSensorState, this.contactState());
    } catch (error) {
      this.platform.log.error('Failed to update contact sensor status', error);
    }

    try {
      const activity = device.activity || 0;
      const tampered = this.isRecentActivity(activity);
      if (activity !== this.state.TamperStatus) {
        this.platform.log.info(`${this.accessory.displayName} Tampered Status: ${tampered} (${this.state.TamperStatus} -> ${activity})`);
      }
      this.state.TamperStatus = activity;
      this.service.updateCharacteristic(C.StatusTampered, tampered);
    } catch (error) {
      this.platform.log.error('Failed to update tampered sensor status', error);
    }
  }

  private contactState(): CharacteristicValue {
    const C = this.platform.Characteristic.ContactSensorState;
    return this.device?.status === 'open' ? C.CONTACT_NOT_DETECTED : C.CONTACT_DETECTED;
  }

  private isRecentActivity(activity: number): boolean {
    const minimumTime = (new Date().getTime() / 1000) - 90;
    return activity > minimumTime;
  }

  async isTampered(): Promise<CharacteristicValue> {
    return this.isRecentActivity(this.device?.activity || 0);
  }

  async isOpen(): Promise<CharacteristicValue> {
    return this.contactState();
  }

}
