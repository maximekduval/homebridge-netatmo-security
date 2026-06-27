/* eslint-disable max-len */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { NetatmoSecurityPlatform, NetatmoAccessory } from '../platform';

export class IndoorSirenAccessory implements NetatmoAccessory {
  private service: Service;
  private device: any;
  private sounding = false;

  constructor(
    private readonly platform: NetatmoSecurityPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device;

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Netatmo-Security')
      .setCharacteristic(this.platform.Characteristic.Model, 'Indoor-Siren')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.id);

    // The original Speaker/Mute mapping shows as "unsupported" in the Home app.
    // A Switch is the supported, controllable representation for a siren.
    const stale = this.accessory.getService(this.platform.Service.Speaker);
    if (stale) {
      this.accessory.removeService(stale);
    }

    this.service = this.accessory.getService(this.platform.Service.Switch)
    || this.accessory.addService(this.platform.Service.Switch);
    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    // No dedicated "siren" service exists in HAP; a Switch is the recommended type.
    // Set the accessory category to Security System for a more fitting Home app icon.
    this.accessory.category = this.platform.api.hap.Categories.SECURITY_SYSTEM;

    this.sounding = this.isSounding(this.device);
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.sounding)
      .onSet(this.setOn.bind(this));
  }

  // Push fresh device data from the platform's single poll loop.
  update(device: any) {
    this.device = device;
    try {
      const sounding = this.isSounding(device);
      if (sounding !== this.sounding) {
        this.platform.log.info(`${this.accessory.displayName} Siren: ${sounding ? 'sounding' : 'silent'}`);
      }
      this.sounding = sounding;
      this.service.updateCharacteristic(this.platform.Characteristic.On, sounding);
    } catch (error) {
      this.platform.log.error('Failed to update siren status', error);
    }
  }

  private async setOn(value: CharacteristicValue) {
    const sounding = value === true;
    try {
      await this.platform.netatmoAPI.setSirenStatus(this.device, sounding);
      this.sounding = sounding;
    } catch (error) {
      const e = error as any;
      // Surface Netatmo's actual error body (e.g. invalid params / missing bridge)
      // so a 400 tells us exactly what to fix.
      const detail = e?.response?.data ? JSON.stringify(e.response.data) : (e?.message ?? error);
      this.platform.log.error(`Failed to ${sounding ? 'trigger' : 'silence'} siren: ` + detail);
      // Revert the switch so the UI reflects that the command did not apply.
      setTimeout(() => this.service.updateCharacteristic(this.platform.Characteristic.On, this.sounding), 500);
    }
  }

  // 'no_sound' (or missing) = silent; any other status = sounding. Some models
  // report this under siren_status, others under status.
  private isSounding(device: any): boolean {
    const raw = device?.siren_status ?? device?.status;
    return raw != null && raw !== 'no_sound';
  }

}
