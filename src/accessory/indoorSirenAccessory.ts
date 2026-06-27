/* eslint-disable max-len */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { NetatmoSecurityPlatform, NetatmoAccessory } from '../platform';

export class IndoorSirenAccessory implements NetatmoAccessory {
  private service: Service;
  private device: any;
  private state = {
    SoundStatus: 'no_sound',
  };

  constructor(
    private readonly platform: NetatmoSecurityPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Netatmo-Security')
      .setCharacteristic(this.platform.Characteristic.Model, 'Indoor-Siren')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id);

    this.service = this.accessory.getService(this.platform.Service.Speaker)
    || this.accessory.addService(this.platform.Service.Speaker);

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.service.getCharacteristic(this.platform.Characteristic.Mute)
      .onGet(this.isMuted.bind(this));
  }

  // Push fresh device data from the platform's single poll loop.
  update(device: any) {
    this.device = device;
    try {
      const soundDetected = device.status !== 'no_sound';
      if (device.status !== this.state.SoundStatus) {
        this.platform.log.info(`${this.accessory.displayName} Sound Status: ${soundDetected} (${this.state.SoundStatus} -> ${device.status})`);
      }
      this.state.SoundStatus = device.status;
      this.service.updateCharacteristic(this.platform.Characteristic.Mute, !soundDetected);
    } catch (error) {
      this.platform.log.error('Failed to update siren sound status', error);
    }
  }

  async isMuted(): Promise<CharacteristicValue> {
    return this.device?.status === 'no_sound';
  }

}
