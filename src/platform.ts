/* eslint-disable @typescript-eslint/no-explicit-any */
import { API, DynamicPlatformPlugin, PlatformAccessory, Logger, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { TagSensorAccessory } from './accessory/tagSensorAccessory';
import NetatmoAPI from './util/NetatmoAPI';

// Each accessory receives door/status data and vibration-event data separately.
// The platform owns both centralized poll loops, instead of every accessory
// polling with its own timers.
export interface NetatmoAccessory {
  update(device: any): void;
  updateEvents(lastSmallMove: number): void;
}

// The indoor siren (NIS) is intentionally not supported: Netatmo's API rejects
// any state-setting property for it (error 21), so it can't be triggered from
// HomeKit, and we don't expose an uncontrollable accessory.
const SUPPORTED_TYPES = ['NACamDoorTag'];
// homesdata is cached after first fetch (see NetatmoAPI.getHomeData). Door states
// use homestatus every 20s (~180 req/h), while the less time-sensitive vibration
// events use getevents every 60s (~60 req/h). This keeps door updates responsive
// while leaving ample headroom below Netatmo's ~500 req/h per-user quota.
const DEFAULT_POLL_INTERVAL_MS = 20000;
const EVENT_POLL_INTERVAL_MS = 60000;
// Keep a conservative lower bound so door-state polling stays responsive without
// encouraging unnecessarily aggressive traffic.
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
  private eventPollTimer?: ReturnType<typeof setTimeout>;
  private eventPollingStarted = false;
  private consecutiveEventFailures = 0;
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

  // Vibration events come from a separate, less reliable Netatmo endpoint. Keep
  // them out of the door-state refresh path so a getevents 503 cannot discard a
  // homestatus response that was already successful.
  async syncEvents() {
    const home = await this.netatmoAPI.getHomeData();
    const events = await this.netatmoAPI.getEvents(home.id);
    const latestSmallMove = new Map<string, number>();

    for (const event of events) {
      if (event.type !== 'tag_small_move' || !event.module_id) {
        continue;
      }
      const time = Number(event.time) || 0;
      latestSmallMove.set(event.module_id, Math.max(latestSmallMove.get(event.module_id) ?? 0, time));
    }

    // Send 0 as well, so a tag with no historical small-move event is initialized
    // and its first future event can produce a HomeKit notification.
    for (const accessory of this.accessories) {
      const deviceId = accessory.context.device?.id;
      if (deviceId) {
        this.handlers.get(accessory.UUID)?.updateEvents(latestSmallMove.get(deviceId) ?? 0);
      }
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
    this.log.info(`Polling Netatmo door states every ${this.pollIntervalMs / 1000}s and vibration events every `
      + `${EVENT_POLL_INTERVAL_MS / 1000}s.`);
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
      // Start only after the first successful device sync. This prevents the two
      // endpoints racing each other during discovery/authentication at startup.
      if (!this.eventPollingStarted) {
        this.eventPollingStarted = true;
        this.runEventPoll();
      }
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

  private scheduleNextEventPoll(delayMs: number) {
    if (this.eventPollTimer) {
      clearTimeout(this.eventPollTimer);
    }
    this.eventPollTimer = setTimeout(() => {
      this.runEventPoll();
    }, delayMs);
    this.eventPollTimer.unref?.();
  }

  // getevents is supplementary: failures are kept at debug level, cached
  // HomeKit door states remain untouched, and only this event loop backs off.
  private async runEventPoll() {
    let delay = EVENT_POLL_INTERVAL_MS;
    try {
      await this.syncEvents();
      this.consecutiveEventFailures = 0;
    } catch (error) {
      this.consecutiveEventFailures++;
      const factor = Math.pow(2, Math.min(this.consecutiveEventFailures - 1, 10));
      const base = Math.min(EVENT_POLL_INTERVAL_MS * factor, MAX_BACKOFF_MS);
      delay = Math.round(base * (0.8 + Math.random() * 0.4));
      this.log.debug(`Failed to refresh Netatmo vibration events (${this.consecutiveEventFailures} consecutive `
        + `failure(s), retrying in ${Math.round(delay / 1000)}s): ` + ((error as any)?.message ?? error));
    }
    this.scheduleNextEventPoll(delay);
  }

}
