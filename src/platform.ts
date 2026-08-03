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
// poll costs 2 API calls (homestatus + getevents). Netatmo enforces ~500 req/h
// per user and answers 429/503 once you cross it, so 15s (~480 req/h) left no
// headroom at all: a single restart or a burst of retries tipped the account
// over and it stayed banned. 20s is ~360 req/h, which keeps a real margin.
const DEFAULT_POLL_INTERVAL_MS = 20000;
// Below this the account is back in rate-limit territory; refuse to go there
// even if the config asks for it.
const MIN_POLL_INTERVAL_MS = 15000;
const MAX_POLL_INTERVAL_MS = 300000;
// When Netatmo fails, backing off is not just about log noise: hammering a
// quota-banned account keeps the ban rolling. Delay doubles per failure, capped.
const MAX_BACKOFF_MS = 300000;
// Don't re-log the same ongoing outage more than once per this window.
const FAILURE_LOG_INTERVAL_MS = 300000;
// Blips of one or two failed polls are normal with Netatmo's cloud; only
// announce a recovery when the outage was long enough to be worth mentioning.
const RECOVERY_LOG_THRESHOLD = 3;

export class NetatmoSecurityPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  private readonly handlers = new Map<string, NetatmoAccessory>();
  public netatmoAPI: NetatmoAPI;
  // Netatmo's cloud API can go flaky for extended periods (bursts of 503s/429s).
  // We back off exponentially while it lasts and log at most one line per
  // FAILURE_LOG_INTERVAL_MS, plus the eventual recovery.
  private consecutiveFailures = 0;
  private lastFailureLogAt = 0;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private readonly pollIntervalMs: number;
  // Unsupported modules are re-seen on every poll; log each one only once.
  private readonly skippedDevices = new Set<string>();

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    log.debug('Finished loading platform:', this.config.name);
    this.pollIntervalMs = this.resolvePollInterval(config.poll_interval);
    this.netatmoAPI = new NetatmoAPI(log, this.api.user.storagePath());
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.netatmoAPI.init(config).then(() => {
        log.debug('Authenticated with provider:', this.config.name);
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

  // Discovery and refresh are the same operation on the same payload, so they run
  // as one pass on every poll. That matters when Netatmo is down at startup: a
  // failed first attempt used to leave the plugin with no accessories until the
  // next Homebridge restart, whereas now the very next successful poll registers
  // them.
  async syncDevices() {
    const devices = await this.netatmoAPI.getHomeDevices();
    for (const device of devices) {
      if (!SUPPORTED_TYPES.includes(device.type)) {
        if (!this.skippedDevices.has(device.id)) {
          this.skippedDevices.add(device.id);
          this.log.debug('Skipped unsupported accessory: ' + device.name);
        }
        continue;
      }
      device.name = (device.name || '').trimEnd();
      const uuid = this.api.hap.uuid.generate(device.id);
      let accessory = this.accessories.find(a => a.UUID === uuid);
      if (!accessory) {
        this.log.info('Adding new accessory: ' + device.name);
        accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        const handler = this.createHandler(accessory);
        if (!handler) {
          continue;
        }
        this.handlers.set(uuid, handler);
        this.accessories.push(accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      accessory.context.device = device;
      this.handlers.get(uuid)?.update(device);
    }
  }

  // The poll interval is configurable so a user whose account keeps getting
  // rate-limited (shared client_id, other integrations on the same account) can
  // trade latency for headroom without editing the plugin.
  private resolvePollInterval(configured: unknown): number {
    const seconds = Number(configured);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return DEFAULT_POLL_INTERVAL_MS;
    }
    const clamped = Math.min(Math.max(seconds * 1000, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS);
    if (clamped !== seconds * 1000) {
      this.log.warn(`Configured poll interval ${seconds}s is out of range; using ${clamped / 1000}s instead.`);
    }
    return clamped;
  }

  // Self-scheduling loop rather than setInterval: a slow or hung poll must never
  // overlap with the next one, otherwise failing polls stack up and multiply the
  // request rate exactly when the API is already refusing calls.
  startRefreshTask() {
    this.log.info(`Polling Netatmo every ${this.pollIntervalMs / 1000}s.`);
    // First pass immediately: it doubles as device discovery, and it reschedules
    // itself (with backoff if it fails).
    this.runPoll();
  }

  private scheduleNextPoll(delayMs: number) {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      this.runPoll();
    }, delayMs);
    // Don't hold the event loop open just for the next poll.
    this.pollTimer.unref?.();
  }

  private async runPoll() {
    try {
      await this.syncDevices();
      if (this.consecutiveFailures >= RECOVERY_LOG_THRESHOLD) {
        this.log.info(`Netatmo status refresh recovered after ${this.consecutiveFailures} failed attempt(s).`);
      } else if (this.consecutiveFailures > 0) {
        this.log.debug(`Netatmo status refresh recovered after ${this.consecutiveFailures} failed attempt(s).`);
      }
      this.consecutiveFailures = 0;
      this.lastFailureLogAt = 0;
      this.scheduleNextPoll(this.pollIntervalMs);
    } catch (error) {
      this.consecutiveFailures++;
      const delay = this.backoffDelay();
      const now = Date.now();
      if (this.consecutiveFailures === 1 || now - this.lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
        this.lastFailureLogAt = now;
        this.log.error(`Failed to refresh status (${this.consecutiveFailures} consecutive failures, `
          + `retrying in ${Math.round(delay / 1000)}s): ` + ((error as any)?.message ?? error));
      }
      this.scheduleNextPoll(delay);
    }
  }

  // Exponential backoff with jitter, capped at MAX_BACKOFF_MS. The jitter keeps
  // several Homebridge instances on the same Netatmo account from retrying in
  // lockstep and re-triggering the quota ban together.
  private backoffDelay(): number {
    const factor = Math.pow(2, Math.min(this.consecutiveFailures - 1, 10));
    const base = Math.min(this.pollIntervalMs * factor, MAX_BACKOFF_MS);
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

}
