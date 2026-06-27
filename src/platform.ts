/* eslint-disable @typescript-eslint/no-explicit-any */
import { API, DynamicPlatformPlugin, PlatformAccessory, Logger, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { TagSensorAccessory } from './accessory/tagSensorAccessory';
import NetatmoAPI from './util/NetatmoAPI';

// Each accessory exposes update(device): the platform owns the single poll loop
// and pushes fresh device data to accessories, instead of every accessory polling
// its own timer.
export interface NetatmoAccessory {
  update(device: any): void;
}

// The indoor siren (NIS) is intentionally not supported: Netatmo's API rejects
// any state-setting property for it (error 21), so it can't be triggered from
// HomeKit, and we don't expose an uncontrollable accessory.
const SUPPORTED_TYPES = ['NACamDoorTag'];
// homesdata is cached after first fetch (see NetatmoAPI.getHomeData), so each
// poll costs 2 API calls (homestatus + getevents). At 15s that's ~480 req/h,
// just under Netatmo's ~500 req/h per-user limit. Don't go below 15s without
// also reducing calls per poll.
const POLL_INTERVAL_MS = 15000;

export class NetatmoSecurityPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  private readonly handlers = new Map<string, NetatmoAccessory>();
  public netatmoAPI: NetatmoAPI;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    log.debug('Finished loading platform:', this.config.name);
    this.netatmoAPI = new NetatmoAPI(log, this.api.user.storagePath());
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.netatmoAPI.init(config).then(async () => {
        log.debug('Authenticated with provider:', this.config.name);
        await this.discoverDevices();
        this.startRefreshTask();
      }).catch((error) => {
        log.error('Netatmo authentication failed, plugin disabled until restart: ' + (error?.message ?? error));
      });
    });
  }

  // Restore a cached accessory: build its handler so the platform can push updates.
  // Accessories whose type is no longer supported (e.g. a previously added siren)
  // are unregistered so they don't linger as orphans in HomeKit.
  configureAccessory(accessory: PlatformAccessory) {
    const handler = this.createHandler(accessory);
    if (handler) {
      this.log.debug('Loading accessory from cache:', accessory.displayName);
      this.handlers.set(accessory.UUID, handler);
      this.accessories.push(accessory);
    } else {
      this.log.info('Removing unsupported cached accessory: ' + accessory.displayName);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  private createHandler(accessory: PlatformAccessory): NetatmoAccessory | undefined {
    switch (accessory.context.device?.type) {
      case 'NACamDoorTag':
        return new TagSensorAccessory(this, accessory);
      default:
        return undefined;
    }
  }

  // Discover devices once: register new accessories, build handlers, push initial state.
  async discoverDevices() {
    let devices: any[];
    try {
      devices = await this.netatmoAPI.getHomeDevices();
    } catch (error) {
      this.log.error('Failed to discover devices: ' + ((error as any)?.message ?? error));
      return;
    }
    for (const device of devices) {
      if (!SUPPORTED_TYPES.includes(device.type)) {
        this.log.debug('Skipped unsupported accessory: ' + device.name);
        continue;
      }
      device.name = (device.name || '').trimEnd();
      const uuid = this.api.hap.uuid.generate(device.id);
      const existing = this.accessories.find(a => a.UUID === uuid);
      if (existing) {
        existing.context.device = device;
      } else {
        this.log.info('Adding new accessory: ' + device.name);
        const accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        const handler = this.createHandler(accessory);
        if (!handler) {
          continue;
        }
        this.handlers.set(uuid, handler);
        this.accessories.push(accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.handlers.get(uuid)?.update(device);
    }
  }

  startRefreshTask() {
    setInterval(() => {
      this.pollDevices().catch((error) => {
        this.log.error('Failed to refresh status: ' + (error?.message ?? error));
      });
    }, POLL_INTERVAL_MS);
  }

  // Single poll loop: fetch all devices and push fresh data to each handler.
  async pollDevices() {
    const devices = await this.netatmoAPI.getHomeDevices();
    for (const device of devices) {
      if (!SUPPORTED_TYPES.includes(device.type)) {
        continue;
      }
      const uuid = this.api.hap.uuid.generate(device.id);
      const handler = this.handlers.get(uuid);
      if (!handler) {
        continue;
      }
      const accessory = this.accessories.find(a => a.UUID === uuid);
      if (accessory) {
        accessory.context.device = device;
      }
      handler.update(device);
    }
  }

}
